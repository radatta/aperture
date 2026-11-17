import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SID, SID2, agent, assistantRow, bash, titleRow } from './fixtures.ts';
import { discover, planFile, scan } from './scan.ts';
import { loadCache, readIndex } from './store.ts';
import { lines, type ReadStats } from './throttle.ts';

let root: string;
let cache: string;
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-scan-'));
  root = join(tmp, 'projects');
  cache = join(tmp, 'cache');
  mkdirSync(root);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const P = '-workspace--claude-worktrees-lane-a';
const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const run = () => scan({ root, cache, maxBps: 1e9 });
const row = (id: string, o = 10, extra: Parameters<typeof assistantRow>[0] = {}) =>
  `${assistantRow({ id, usage: { i: 1, cw: 10, cr: 100, o }, ...extra })}\n`;

describe('lines (throttled reader)', () => {
  it('yields complete lines only, stops at end, and leaves a trailing partial line for later', async () => {
    write('f.jsonl', 'aa\nbbb\ncc');
    const st: ReadStats = { bytes: 0, skipped: 0, done: 0 };
    const got: string[] = [];
    for await (const l of lines(join(root, 'f.jsonl'), { end: 10, maxBps: 1e9, hwm: 2 }, st))
      got.push(l.line.toString());
    expect(got).toEqual(['aa', 'bbb']);
    expect(st.done).toBe(7);
  });

  it('skips and counts a line over maxLine without buffering it', async () => {
    write('f.jsonl', `${'x'.repeat(50)}\nok\n`);
    const st: ReadStats = { bytes: 0, skipped: 0, done: 0 };
    const got: string[] = [];
    for await (const l of lines(join(root, 'f.jsonl'), { end: 54, maxBps: 1e9, maxLine: 10, hwm: 4 }, st))
      got.push(l.line.toString());
    expect(got).toEqual(['ok']);
    expect(st.skipped).toBe(1);
  });

  it('keeps to maxBps', async () => {
    write('f.jsonl', `${'y'.repeat(999)}\n`.repeat(20)); // 20 kB
    const t0 = Date.now();
    for await (const _ of lines(join(root, 'f.jsonl'), { end: 20_000, maxBps: 100_000, hwm: 1000 }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });
});

describe('discover and planFile', () => {
  it('finds main, subagent and workflow transcripts and nothing else', () => {
    write(`${P}/${SID}.jsonl`, '');
    write(`${P}/${SID}/subagents/agent-a1.jsonl`, '');
    write(`${P}/${SID}/subagents/agent-a1.meta.json`, '{}');
    write(`${P}/${SID}/subagents/workflows/wf_x-1/agent-w1.jsonl`, '');
    write(`${P}/${SID}/tool-results/t.txt`, 'x');
    write(`${P}/notes.jsonl`, '');
    expect(discover(root).map((f) => f.ref.kind).sort()).toEqual(['main', 'subagent', 'workflow']);
  });

  it('skips unchanged files, resumes grown ones, rescans shrunk or replaced ones', () => {
    const f = { rel: 'r', ref: {} as never, size: 100, mtimeMs: 5, ino: 7 };
    const prev = { size: 100, mtimeMs: 5, ino: 7, offset: 90, skipped: 0 };
    expect(planFile(f, undefined)).toEqual({ action: 'full' });
    expect(planFile(f, prev)).toEqual({ action: 'skip' });
    expect(planFile({ ...f, size: 150, mtimeMs: 6 }, prev)).toEqual({ action: 'resume', from: 90 });
    expect(planFile({ ...f, size: 50, mtimeMs: 6 }, prev)).toEqual({ action: 'full' });
    expect(planFile({ ...f, ino: 8 }, prev)).toEqual({ action: 'full' });
  });
});

describe('scan', () => {
  it('handles an empty or missing projects root', async () => {
    expect(await run()).toMatchObject({ files: 0, scanned: 0 });
    rmSync(root, { recursive: true });
    expect(await run()).toMatchObject({ files: 0 });
  });

  it('caches calls, markers, the name and subagent metadata; a second run does no work', async () => {
    write(
      `${P}/${SID}.jsonl`,
      `${titleRow('lane-a')}\n${row('m1', 10, { tools: [agent('code-reviewer')] })}${row('m1', 40)}`,
    );
    write(`${P}/${SID}/subagents/agent-a1.jsonl`, row('m2'));
    write(
      `${P}/${SID}/subagents/agent-a1.meta.json`,
      JSON.stringify({ agentType: 'code-reviewer', description: 'free text, not kept' }),
    );
    expect(await run()).toMatchObject({ files: 2, scanned: 2 });
    const l = loadCache(cache);
    expect(l.calls.map((c) => [c.id, c.o])).toEqual([
      ['m1', 40],
      ['m2', 10],
    ]);
    const main = l.sessions.find((s) => s.kind === 'main')!;
    expect(main).toMatchObject({ name: 'lane-a', cwd: '/workspace/.claude/worktrees/lane-a' });
    expect(l.sessions.find((s) => s.kind === 'subagent')).toMatchObject({ agentType: 'code-reviewer' });
    expect(JSON.stringify(l.sessions)).not.toContain('free text');
    expect(l.markers.get(main.rel)!.map((m) => m.kind)).toEqual(['review', 'spawn']);
    expect(await run()).toMatchObject({ scanned: 0 });
  });

  it('resumes a grown file from its offset, merging a request split across the boundary', async () => {
    const rel = `${P}/${SID}.jsonl`;
    write(rel, `${row('m1', 5)}{"type":"assistant","trunc`);
    await run();
    expect(loadCache(cache).calls).toHaveLength(1);
    // the torn line is completed by a rewrite of its tail, then the same request logs a larger output
    write(rel, `${row('m1', 5)}${row('m2', 1, { tools: [bash('pnpm board lane gate')] })}${row('m1', 99)}`);
    await run();
    const l = loadCache(cache);
    expect(l.calls.map((c) => [c.id, c.o])).toEqual([
      ['m1', 99],
      ['m2', 1],
    ]);
    expect(readIndex(cache).files[rel].offset).toBe(Buffer.byteLength(row('m1', 5) + row('m2', 1, { tools: [bash('pnpm board lane gate')] }) + row('m1', 99)));
  });

  it('rescans a file that shrank (rewritten) instead of resuming past its end', async () => {
    const rel = `${P}/${SID}.jsonl`;
    write(rel, row('m1') + row('m2') + row('m3'));
    await run();
    write(rel, row('m9'));
    await run();
    expect(loadCache(cache).calls.map((c) => c.id)).toEqual(['m9']);
  });

  it('counts a message found in two files once, owned by the subagent file', async () => {
    write(`${P}/${SID}.jsonl`, row('m1'));
    write(`${P}/${SID}/subagents/agent-a1.jsonl`, row('m1'));
    write(`-workspace/${SID2}.jsonl`, row('m1'));
    await run();
    const l = loadCache(cache);
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0].file).toBe(`${P}/${SID}/subagents/agent-a1.jsonl`);
    expect(l.dupes).toBe(2);
  });

  it('appended lines after a scan are picked up next run', async () => {
    const rel = `${P}/${SID}.jsonl`;
    write(rel, row('m1'));
    await run();
    appendFileSync(join(root, rel), row('m2'));
    await run();
    expect(loadCache(cache).calls.map((c) => c.id)).toEqual(['m1', 'm2']);
  });

  it('waits on memory before a big file and gives up loudly when it stays high', async () => {
    write(`${P}/${SID}.jsonl`, row('m1'));
    await expect(
      scan({ root, cache, maxBps: 1e9, bigFile: 0, waitMs: 0, memoryOk: () => false, log: () => {} }),
    ).rejects.toThrow(/memory stayed high/);
  }, 1000);
});
