// tools/coi/xclip, the container's xclip stand-in, run for real against a temp .hostjobs with this test playing the
// Mac: it answers only Claude Code's two image calls, never text, and never hangs a Ctrl+V past its cap.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateJob } from './job.ts';

const SHIM = fileURLToPath(new URL('../../../tools/coi/xclip', import.meta.url));
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('image'),
]);
const TARGETS = ['-selection', 'clipboard', '-t', 'TARGETS', '-o'];
const IMAGE = ['-selection', 'clipboard', '-t', 'image/png', '-o'];

let T: string;
let hj: string;
beforeEach(() => {
  T = mkdtempSync(join(tmpdir(), 'xclip-shim-'));
  hj = join(T, 'hj');
  for (const d of ['inbox', 'results', 'staging']) mkdirSync(join(hj, d), { recursive: true });
});
afterEach(() => rmSync(T, { recursive: true, force: true }));

function xclip(
  args: string[],
  o: { pane?: string; waitMs?: number; graceMs?: number; stdin?: string } = {},
) {
  const child = spawn(SHIM, args, {
    env: {
      PATH: process.env.PATH,
      HOME: T,
      TMUX_PANE: o.pane ?? '%1',
      XCLIP_SHIM_HOSTJOBS: hj,
      XCLIP_SHIM_WAIT_MS: String(o.waitMs ?? 10_000),
      XCLIP_SHIM_GRACE_MS: String(o.graceMs ?? 12_000),
      XCLIP_SHIM_CACHE: join(T, 'cache'),
      XCLIP_SHIM_LOG: join(T, 'log'),
    },
  });
  const out: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => out.push(b));
  child.stdin.on('error', () => {}); // a refused copy exits before reading
  child.stdin.end(o.stdin ?? '');
  const t0 = Date.now();
  return new Promise<{ code: number | null; out: Buffer; ms: number }>((resolve) =>
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out), ms: Date.now() - t0 })),
  );
}

const inbox = () => readdirSync(join(hj, 'inbox'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function nextJob(): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const [f] = inbox();
    if (f) return f.replace(/\.json$/, '');
    await sleep(20);
  }
  throw new Error(
    `no job queued; shim log:\n${existsSync(join(T, 'log')) ? readFileSync(join(T, 'log'), 'utf8') : '(none)'}`,
  );
}
// The Mac's half: take the job out of the inbox and answer it.
async function answer(result: Record<string, unknown>, png: Buffer | null = PNG): Promise<unknown> {
  const id = await nextJob();
  const job: unknown = JSON.parse(readFileSync(join(hj, 'inbox', `${id}.json`), 'utf8'));
  rmSync(join(hj, 'inbox', `${id}.json`));
  mkdirSync(join(hj, 'results', id));
  if (png) writeFileSync(join(hj, 'results', id, 'clip.png'), png);
  writeFileSync(
    join(hj, 'results', id, 'result.json'),
    JSON.stringify({ v: 1, id, job: 'clip', ...result }),
  );
  return { id, job };
}

// Timings are loose: under a full parallel suite a bash + jq start can take seconds (contention, CLAUDE.md).
describe('tools/coi/xclip', { timeout: 30_000 }, () => {
  it('Ctrl+V: TARGETS asks the Mac with a valid clip job; image/png then prints the PNG once', async () => {
    const run = xclip(TARGETS);
    const { id, job } = (await answer({ status: 'served', reason: null })) as {
      id: string;
      job: unknown;
    };
    const t = await run;
    expect(t.code).toBe(0);
    expect(t.out.toString()).toBe('TARGETS\nimage/png\n');
    expect(validateJob(job, id, Date.now())).toBeNull();
    expect(job).toMatchObject({ job: 'clip', expiresInMin: 1, params: {} });
    expect(existsSync(join(hj, 'results', id, 'clip.png'))).toBe(false); // not left in the shared folder
    const img = await xclip(IMAGE);
    expect(img.code).toBe(0);
    expect(img.out.equals(PNG)).toBe(true);
    expect((await xclip(IMAGE)).code).toBe(1); // served once
  });

  it('makes a valid job id every time (4 random hex)', async () => {
    for (let i = 0; i < 30; i++) {
      const run = xclip(TARGETS);
      await answer({ status: 'rejected', reason: 'NO_IMAGE' }, null);
      expect((await run).code).toBe(1);
    }
    const ids = readdirSync(join(hj, 'results'));
    expect(ids).toHaveLength(30);
    for (const id of ids) expect(id).toMatch(/^[0-9]{8}T[0-9]{6}Z-clip-[0-9a-f]{4}$/);
  });

  it('refuses every other call Claude Code makes — text, primary, bmp, copy — with no output and no job', async () => {
    const calls = [
      ['-selection', 'clipboard', '-t', 'text/plain', '-o'],
      ['-selection', 'clipboard', '-o'],
      ['-selection', 'primary', '-o'],
      ['-selection', 'clipboard', '-t', 'image/bmp', '-o'],
      ['-selection', 'clipboard'],
      ['-selection', 'clipboard', '-i'],
      ['-o'],
      [],
      [...TARGETS, '-extra'],
      ['-selection clipboard', '-t TARGETS -o'], // the same words, split differently
      ['-selection', 'clipboard', '-t', 'text/plain', '-o', 'x'],
    ];
    for (const a of calls) {
      const r = await xclip(a, { stdin: 'some text to copy' });
      expect([a.join(' '), r.code, r.out.length]).toEqual([a.join(' '), 1, 0]);
    }
    expect(inbox()).toEqual([]);
  });

  it('no answer: the job is withdrawn and Ctrl+V gives up at the cap', async () => {
    const r = await xclip(TARGETS, { waitMs: 700 });
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(6000);
    expect(inbox()).toEqual([]);
    expect(
      readdirSync(join(hj, 'staging')).filter((f) => f.endsWith('.withdrawn.json')),
    ).toHaveLength(1);
  });

  it('an answer after the wait, once the Mac took the job, is still collected (its clip.png never left behind)', async () => {
    const run = xclip(TARGETS, { waitMs: 800, graceMs: 8000 });
    const id = await nextJob();
    rmSync(join(hj, 'inbox', `${id}.json`)); // the Mac took it…
    mkdirSync(join(hj, 'results', id));
    await sleep(1500); // …and answers after the shim's first wait
    writeFileSync(join(hj, 'results', id, 'clip.png'), PNG);
    writeFileSync(
      join(hj, 'results', id, 'result.json'),
      JSON.stringify({ v: 1, id, job: 'clip', status: 'served', reason: null }),
    );
    const r = await run;
    expect(r.code).toBe(0);
    expect(existsSync(join(hj, 'results', id, 'clip.png'))).toBe(false);
  });

  it('the Mac took it and never answered: gives up after the grace', async () => {
    const run = xclip(TARGETS, { waitMs: 500, graceMs: 700 });
    const id = await nextJob();
    rmSync(join(hj, 'inbox', `${id}.json`));
    const r = await run;
    expect(r.code).toBe(1);
    expect(readdirSync(join(hj, 'staging')).filter((f) => f.includes(id))).toEqual([]);
  });

  it('sweeps an uncollected clip.png after 30 s and a clip job’s leftovers after an hour, nothing else', async () => {
    const put = (rel: string, ageS: number, data = 'x') => {
      const p = join(hj, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, data);
      const t = Date.now() / 1000 - ageS;
      utimesSync(p, t, t);
      return p;
    };
    const lateLeft = put('results/20261113T000000Z-clip-aa11/clip.png', 60);
    const fresh = put('results/20261113T000001Z-clip-bb22/clip.png', 2);
    const oldRes = put('results/20261113T000002Z-clip-cc33/result.json', 7200);
    const t = Date.now() / 1000 - 7200;
    utimesSync(join(hj, 'results/20261113T000002Z-clip-cc33'), t, t);
    const oldW = put('staging/20261113T000003Z-clip-dd44.withdrawn.json', 7200);
    const notClip = put('results/20261113T000004Z-mac-mailroom-ee55/result.json', 7200);
    utimesSync(join(hj, 'results/20261113T000004Z-mac-mailroom-ee55'), t, t);
    const run = xclip(TARGETS);
    await answer({ status: 'rejected', reason: 'NO_IMAGE' }, null);
    await run;
    expect([lateLeft, oldRes, oldW].map(existsSync)).toEqual([false, false, false]);
    expect(existsSync(join(hj, 'results/20261113T000002Z-clip-cc33'))).toBe(false);
    expect([fresh, notClip].map(existsSync)).toEqual([true, true]);
  });

  it('a refusal from the Mac pastes nothing', async () => {
    const run = xclip(TARGETS);
    await answer({ status: 'rejected', reason: 'NO_IMAGE' }, null);
    const r = await run;
    expect([r.code, r.out.length]).toEqual([1, 0]);
    expect((await xclip(IMAGE)).code).toBe(1);
  });

  it('a served file that is not a PNG is refused and deleted', async () => {
    const run = xclip(TARGETS);
    const { id } = (await answer({ status: 'served', reason: null }, Buffer.from('GIF89a'))) as {
      id: string;
    };
    expect((await run).code).toBe(1);
    expect(existsSync(join(hj, 'results', id, 'clip.png'))).toBe(false);
    expect((await xclip(IMAGE)).code).toBe(1);
  });

  it('a busy runner (a fresh heartbeat, no result) fails at once and queues nothing; a stale one does not count', async () => {
    mkdirSync(join(hj, 'results', 'sim-run'));
    const hb = join(hj, 'results', 'sim-run', 'progress.json');
    writeFileSync(hb, '{}');
    const busy = await xclip(TARGETS);
    expect(busy.code).toBe(1);
    expect(busy.ms).toBeLessThan(5000); // well inside the 10 s wait: it never queued
    expect(inbox()).toEqual([]);
    const old = Date.now() / 1000 - 120;
    utimesSync(hb, old, old);
    const run = xclip(TARGETS);
    await answer({ status: 'served', reason: null });
    expect((await run).code).toBe(0);
  });

  it('no mailroom (no inbox) fails at once', async () => {
    rmSync(join(hj, 'inbox'), { recursive: true });
    const r = await xclip(TARGETS);
    expect([r.code, r.out.length]).toEqual([1, 0]);
  });

  it('each tmux pane keeps its own image: two sessions never cross', async () => {
    const run = xclip(TARGETS, { pane: '%1' });
    await answer({ status: 'served', reason: null });
    expect((await run).code).toBe(0);
    expect((await xclip(IMAGE, { pane: '%2' })).code).toBe(1);
    expect((await xclip(IMAGE, { pane: '%1' })).out.equals(PNG)).toBe(true);
  });

  it('a kept image older than 10 s is not served', async () => {
    const run = xclip(TARGETS);
    await answer({ status: 'served', reason: null });
    expect((await run).code).toBe(0);
    const kept = join(T, 'cache', '1.png');
    const old = Date.now() / 1000 - 30;
    utimesSync(kept, old, old);
    expect((await xclip(IMAGE)).code).toBe(1);
    expect(existsSync(kept)).toBe(false);
  });

  it('refuses a cache dir anyone else can read', async () => {
    mkdirSync(join(T, 'cache'));
    chmodSync(join(T, 'cache'), 0o755);
    const r = await xclip(TARGETS);
    expect(r.code).toBe(1);
    expect(inbox()).toEqual([]);
  });
});
