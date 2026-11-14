import { describe, expect, it } from 'vitest';
import { makeClipJob, validateClipParams, clipProbe } from './clip.ts';
import { memFs } from './fakes.ts';
import { validateJob } from './job.ts';

const DIR = '/hj';
const NOW = Date.parse('2026-11-13T23:15:00Z');

function rig(answer?: (id: string, fs: ReturnType<typeof memFs>) => void) {
  const fs = memFs([`${DIR}/inbox`]);
  let t = NOW;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  fs.onRename = (_a, b) => {
    const m = /\/inbox\/(.+)\.json$/.exec(b);
    if (m?.[1] && answer) answer(m[1], fs);
  };
  const log: string[] = [];
  const copies: string[][] = [];
  const removed: string[] = [];
  const d = {
    fs,
    clock,
    dir: DIR,
    out: '/out.png',
    log: (s: string) => log.push(s),
    copy: (a: string, b: string) => copies.push([a, b]),
    remove: (p: string) => removed.push(p),
  };
  return { d, fs, log, copies, removed };
}
const result = (id: string, r: Record<string, unknown>) =>
  JSON.stringify({ v: 1, id, job: 'clip', durationMs: 900, ...r });

describe('the clip job, container side', () => {
  it('makes a job the runner takes: {} params, a 1-minute life', () => {
    const job = makeClipJob(NOW, 'ab12');
    expect(job).toEqual({
      v: 1,
      id: '20261113T231500Z-clip-ab12',
      job: 'clip',
      submittedAt: '2026-11-13T23:15:00Z',
      expiresInMin: 1,
      params: {},
    });
    expect(validateJob(job, job.id, NOW)).toBeNull();
  });

  it('params must be {} and the life at most 2 min', () => {
    expect(validateClipParams({}, 2)).toBeNull();
    expect(validateClipParams({}, 3)).toBe('BAD_PARAM');
    expect(validateClipParams({ path: '/etc/passwd' }, 1)).toBe('BAD_PARAM');
    expect(validateClipParams([], 1)).toBe('BAD_PARAM');
    expect(validateClipParams(null, 1)).toBe('BAD_PARAM');
  });

  it('clip-probe: a served image is copied out, and its copy in the shared folder deleted', async () => {
    const { d, log, copies, removed } = rig((id, fs) =>
      fs.files.set(
        `${DIR}/results/${id}/result.json`,
        result(id, {
          status: 'served',
          reason: null,
          clip: { bytes: 21, source: 'png', frontmost: 'com.googlecode.iterm2' },
        }),
      ),
    );
    expect(await clipProbe(d)).toBe(0);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.[1]).toBe('/out.png');
    expect(removed).toEqual([copies[0]?.[0]]);
    expect(log.join('\n')).toContain('served 21 bytes (png, com.googlecode.iterm2 in front)');
  });

  it('clip-probe: a refusal says why and copies nothing', async () => {
    const { d, log, copies } = rig((id, fs) =>
      fs.files.set(
        `${DIR}/results/${id}/result.json`,
        result(id, { status: 'rejected', reason: 'NOT_FRONTMOST' }),
      ),
    );
    expect(await clipProbe(d)).toBe(1);
    expect(copies).toEqual([]);
    expect(log.join('\n')).toContain('a terminal (iTerm2 or Terminal) must be the frontmost app');
  });

  it('clip-probe: no answer withdraws the job (exit 3)', async () => {
    const { d, fs, log } = rig();
    expect(await clipProbe(d, 1000)).toBe(3);
    expect([...fs.files.keys()].some((k) => k.endsWith('.withdrawn.json'))).toBe(true);
    expect(log.join('\n')).toContain('withdrawn');
  });

  it('clip-probe: taken but answered late, the image is still collected', async () => {
    const { d, fs, copies, removed } = rig();
    fs.onRename = (_a, b) => {
      const m = /\/inbox\/(.+)\.json$/.exec(b);
      if (!m?.[1]) return;
      const id = m[1];
      fs.files.delete(b); // the Mac took it
      const start = d.clock.now();
      const read = fs.read;
      fs.read = (p) => {
        if (p.endsWith(`${id}/result.json`) && d.clock.now() - start > 16_000)
          return result(id, { status: 'served', reason: null });
        return read(p);
      };
    };
    expect(await clipProbe(d)).toBe(0);
    expect(copies).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  it('clip-probe: a failed copy still deletes the shared image', async () => {
    const { d, removed } = rig((id, fs) =>
      fs.files.set(
        `${DIR}/results/${id}/result.json`,
        result(id, { status: 'served', reason: null }),
      ),
    );
    d.copy = () => {
      throw new Error('EACCES');
    };
    await expect(clipProbe(d)).rejects.toThrow('EACCES');
    expect(removed).toHaveLength(1);
  });

  it('clip-probe: no mailroom is exit 3', async () => {
    const { d } = rig();
    d.fs.dirs.clear();
    expect(await clipProbe(d)).toBe(3);
  });
});
