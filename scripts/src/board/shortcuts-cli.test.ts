// The hub's shortcut verbs end to end (docs/ops/HUB.md → Shortcuts): board/cli.ts spawned on a temp board inside a
// temp git repo, plus a linked worktree, where every writer must refuse.
import { execFileSync, spawnSync } from 'node:child_process';
import {
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseQueue } from './tower/queue.ts';

const CLI = join(import.meta.dirname, 'cli.ts');
let root: string, repo: string, wt: string, board: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shortcuts-'));
  repo = join(root, 'repo');
  wt = join(root, 'wt');
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  g('worktree', 'add', '-q', '-b', 'lane', wt);
  board = join(repo, 'localNotes', 'board');
  mkdirSync(board, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cli = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
  const cwd = opts.cwd ?? repo;
  const r = spawnSync('node', [CLI, ...args], {
    cwd,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, APERTURE_BOARD_DIR: board, INIT_CWD: cwd, TZ: 'UTC' },
  });
  return { status: r.status, out: r.stdout.trimEnd(), err: r.stderr.trimEnd() };
};
const queueFile = () => join(board, 'queue.json');
const seed = (extra: Record<string, unknown> = {}) =>
  writeFileSync(
    queueFile(),
    JSON.stringify(
      { v: 1, updatedAt: '2026-11-18T19:00:00Z', devQueue: [], keepMe: { x: 1 }, ...extra },
      null,
      2,
    ) + '\n',
  );
const queue = () => JSON.parse(readFileSync(queueFile(), 'utf8'));
const noTmp = () => expect(readdirSync(board).filter((f) => f.includes('.tmp.'))).toEqual([]);

describe('asks', () => {
  it('add, list, answer, show, close: the file stays parseable and keeps unknown keys', () => {
    seed();
    const add = (o: object) => cli(['asks', 'add'], { input: JSON.stringify(o) });
    expect(
      add({
        text: 'Cache key?',
        options: ['per branch', 'per lockfile'],
        pick: 'b',
        lane: 'warm-caches',
      }),
    ).toEqual({ status: 0, out: 'd1', err: '' });
    expect(add({ text: 'Apply the skills patch', pane: 'dispatch', go: 'go 1a2b3c4d' }).out).toBe(
      'd2',
    );
    expect(cli(['asks', 'list']).out).toMatch(
      /^ASKS 2 open · newest d2\nd1 · \d\d:\d\d · warm-caches · Cache key\?\n/,
    );
    expect(
      JSON.parse(cli(['asks', 'list', '--json']).out).map((a: { id: string }) => a.id),
    ).toEqual(['d1', 'd2']);

    expect(cli(['asks', 'answer', 'all', 'ok']).err).toMatch(/wants --upto d<n>/); // what the user saw
    expect(cli(['asks', 'answer', 'd1', 'ok', 'd2']).err).toMatch(/goes only with `all ok`/);
    const ok = cli(['asks', 'answer', 'all', 'ok', 'd2']);
    expect(ok.status).toBe(0);
    expect(ok.out.split('\n')).toEqual([
      'ANSWERED d1: b) per lockfile (the pick)',
      'relay to warm-caches: [relay] warm-caches — the user: "d1 ok" → "Cache key?" = b) per lockfile',
      'GO NEEDED d2: type in the dispatch pane: go 1a2b3c4d (a reply here is not the go)',
    ]);
    const q = queue();
    expect(q.keepMe).toEqual({ x: 1 });
    expect(q.askSeq).toBe(2);
    expect(parseQueue(JSON.stringify(q)).problems).toEqual([]);
    expect(q.asks.map((a: { status: string }) => a.status)).toEqual(['answered', 'open']);
    expect(cli(['asks', 'show', 'd1']).out).toMatch(/answered b\) per lockfile at \d\d:\d\d$/);

    expect(cli(['asks', 'close', 'd2'])).toEqual({ status: 0, out: 'CLOSED d2', err: '' });
    expect(cli(['asks', 'list']).out).toBe('ASKS none open');
    noTmp();
  });

  it('a pane ask answered by letter writes nothing', () => {
    seed();
    cli(['asks', 'add'], {
      input: JSON.stringify({ text: 'Type go', options: ['go', 'no'], pane: 'warm-caches' }),
    });
    const before = readFileSync(queueFile(), 'utf8');
    const r = cli(['asks', 'answer', 'd1', 'a']);
    expect(r).toEqual({
      status: 0,
      out: 'GO NEEDED d1: type in the warm-caches pane: go (a reply here is not the go)',
      err: '',
    });
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
  });

  it('refuses a write that would not parse, a bad stdin and a bad reply, leaving the file as it was', () => {
    seed();
    const before = readFileSync(queueFile(), 'utf8');
    for (const [input, why] of [
      [
        JSON.stringify({ text: 'one option', options: ['only'] }),
        /would not parse: asks\[0\]: wants 2 to 6 options/,
      ],
      [
        JSON.stringify({ text: 't', options: ['a', 'b'], pick: 'z' }),
        /would not parse: asks\[0\]: pick "z"/,
      ],
      ['not json', /stdin is not JSON/],
      [JSON.stringify({ text: 't', status: 'answered' }), /unknown field status/],
    ] as const) {
      const r = cli(['asks', 'add'], { input });
      expect(r.status).toBe(2);
      expect(r.err).toMatch(why);
    }
    expect(cli(['asks', 'answer', 'd1', 'a']).err).toMatch(/no ask d1/);
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
    noTmp();
  });

  it('a linked worktree may read but never write the hub files', () => {
    seed();
    cli(['asks', 'add'], { input: JSON.stringify({ text: 'Cache key?', options: ['a', 'b'] }) });
    const before = readFileSync(queueFile(), 'utf8');
    expect(cli(['asks', 'list'], { cwd: wt }).out).toMatch(/^ASKS 1 open/);
    for (const args of [
      ['asks', 'add'],
      ['asks', 'answer', 'd1', 'a'],
      ['asks', 'close', 'd1'],
      ['away'],
      ['back'],
      ['stop', '22:30'],
    ]) {
      const r = cli(args, { cwd: wt, input: '{"text":"t","options":["a","b"]}' });
      expect([r.status, r.err]).toEqual([
        2,
        expect.stringMatching(/writes the hub's files: run it from the main checkout/),
      ]);
    }
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
    expect(existsSync(join(board, 'away.json'))).toBe(false);
    expect(existsSync(join(board, 'stop.json'))).toBe(false);
  });

  it('a problem already on file never blocks the writes, and asks writes leave updatedAt alone', () => {
    seed({
      askSeq: 1,
      asks: [
        { id: 'd1', asked: 'soon', text: 'hand-written', options: ['a', 'b'], status: 'open' },
      ],
    });
    expect(parseQueue(readFileSync(queueFile(), 'utf8')).problems).toEqual([
      'asks[0]: asked is not an ISO time',
    ]);
    expect(
      cli(['asks', 'add'], { input: JSON.stringify({ text: 't', options: ['x', 'y'] }) }).out,
    ).toBe('d2');
    expect(cli(['asks', 'close', 'd1']).out).toBe('CLOSED d1');
    expect(queue().updatedAt).toBe('2026-11-18T19:00:00Z'); // the hub's last look at the whole queue
    // a new problem still refuses
    expect(
      cli(['asks', 'add'], { input: JSON.stringify({ text: 't', options: ['x'] }) }).err,
    ).toMatch(/would not parse: asks\[2\]: wants 2 to 6 options/);
  });

  it('prunes answered asks past a day on the next write, keeping askSeq', () => {
    seed({
      askSeq: 4,
      asks: [
        {
          id: 'd4',
          asked: '2026-11-10T10:00:00Z',
          text: 'old',
          options: ['a', 'b'],
          status: 'answered',
          answer: 'a',
          answeredAt: '2026-11-10T10:05:00Z',
        },
      ],
    });
    expect(
      cli(['asks', 'add'], { input: JSON.stringify({ text: 't', options: ['x', 'y'] }) }).out,
    ).toBe('d5');
    expect(queue().asks.map((a: { id: string }) => a.id)).toEqual(['d5']);
    expect(queue().askSeq).toBe(5);
  });
});

describe('merge-line', () => {
  const file = () => join(board, 'merge-line.txt');
  it('no file yet: refuses, naming the tower', () => {
    rmSync(file(), { force: true });
    expect(cli(['merge-line']).err).toMatch(/no .*merge-line.txt yet: the web tower writes it/);
  });
  const SHA = 'a'.repeat(40);
  const cmd = (n: number) =>
    `GH_PAGER=cat gh pr merge ${n} --squash --admin --body "" --match-head-commit ${SHA}`;
  it('a fresh file: the line gets a fresh ran marker (and the root note here, with no mac-root)', () => {
    writeFileSync(
      file(),
      `MERGE 1 · landing order: PR 7 a\ncd <mac-repo> && ${cmd(7)}\nleft out, on hold: PR 5 b\u001b[2J\n`,
    );
    const r = cli(['merge-line']);
    expect(r.status).toBe(0);
    const [head, line, note, rootNote] = r.out.split('\n');
    expect(head).toBe('MERGE 1 · landing order: PR 7 a');
    expect(line).toMatch(
      /^cd <mac-repo> && .* --match-head-commit a{40}; \(r=\$\?; set -C; echo \$r > <mac-repo>\/localNotes\/board\/ran\/merge-[0-9a-z]{4}\)$/,
    );
    expect(note).toBe('left out, on hold: PR 5 b [2J'); // a shared file's control bytes never reach the terminal
    expect(rootNote).toMatch(/^\(<mac-repo> is the Mac repo path/);
    const id = /ran\/(merge-[0-9a-z]{4})\)$/.exec(line!)![1]!;
    expect(existsSync(join(board, 'ran', `.${id}`))).toBe(true); // reserved, create-only
    expect(cli(['merge-line']).out).not.toContain(`ran/${id})`); // the next print gets its own id
  });
  it('the file is shared, so its line is re-checked: anything but the pinned shape for this root prints no line', () => {
    for (const bad of [
      'cd <mac-repo> && GH_PAGER=cat gh pr merge 7 --squash', // unpinned
      `cd <mac-repo> && ${cmd(7)} && touch x`,
      `cd <mac-repo> && ${cmd(7)}; rm x`,
      `cd /elsewhere && ${cmd(7)}`, // a root the CLI doesn't have (a tower started before mac-root)
      `cd <mac-repo> && ${cmd(7)}\ncd <mac-repo> && ${cmd(8)}`, // two lines
      `cd <mac-repo> && ${cmd(7).replace(SHA, 'b'.repeat(39))}`,
    ]) {
      writeFileSync(file(), `MERGE 1 · landing order: PR 7 a\n${bad}\n`);
      const r = cli(['merge-line']);
      expect([r.status, r.out]).toEqual([2, '']);
      expect(r.err).toMatch(/not the shape the tower writes for cd <mac-repo>, so no line printed/);
    }
    writeFileSync(
      file(),
      `MERGE 2 · landing order: PR 7 a, PR 8 b\ncd <mac-repo> && ${cmd(7)} && ${cmd(8)}\n`,
    );
    expect(cli(['merge-line']).status).toBe(0);
  });
  it('nothing to merge: the file as is, no marker minted', () => {
    writeFileSync(file(), 'MERGE none\n');
    expect(cli(['merge-line']).out).toBe('MERGE none');
  });
  it('a stale file prints no line to run', () => {
    writeFileSync(file(), 'MERGE 1 · landing order: PR 7 a\ncd <mac-repo> && x\n');
    const old = Date.now() / 1000 - 600;
    utimesSync(file(), old, old);
    const r = cli(['merge-line']);
    expect(r.out).toMatch(
      /^TOWER DOWN: the merge line is from \d\d:\d\d, no line printed .*\nMERGE 1 · landing order: PR 7 a$/,
    );
    expect(r.out).not.toMatch(/^cd /m);
  });
});

describe('wi, away, back, stop', () => {
  it('wi reads followups, and says when it finds nothing', () => {
    seed({
      followups: [
        {
          id: 'F9',
          what: 'w',
          owner: 'lane',
          after: 'now',
          status: 'open',
          source: 's',
          since: '2026-11-14',
        },
      ],
    });
    expect(cli(['wi', 'F9']).out).toBe('F9 · open · lane · after now · since 11-14 · w (s)');
    expect(cli(['wi', 'PR', '7']).status).toBe(2); // one argument: `wi 7` or `wi "PR 7"`
    expect(cli(['wi', 'PR 7']).out).toMatch(/^PR 7: no pr-index.json yet/);
    writeFileSync(queueFile(), '{');
    expect(cli(['wi', 'd3']).out).toMatch(/^unknown: d3 \(queue.json bad/); // never "not found"
  });
  it('away stamps, back digests and clears the stamp, a second back refuses', () => {
    seed();
    writeFileSync(
      join(board, 'board.line'),
      `1 2 3 ok\nusage ${Math.floor(Date.now() / 1000)} usage 41% · 2%/h\n`,
    );
    expect(cli(['away', 'ping']).out).toMatch(
      /^AWAY since \d\d:\d\d · ping on asks · usage 41% · 2%\/h \(\d\d:\d\d\)$/,
    );
    expect(cli(['away', 'later']).err).toMatch(/usage: away \[ping\]/);
    const first = JSON.parse(readFileSync(join(board, 'away.json'), 'utf8')).at;
    expect(cli(['away']).out).toMatch(/^AWAY still, since \d\d:\d\d · usage then 41%/); // the first stamp stands
    expect(JSON.parse(readFileSync(join(board, 'away.json'), 'utf8'))).toMatchObject({
      at: first,
      ping: false,
    });
    const b = cli(['back']);
    expect(b.out).toMatch(
      /^BACK \d\d:\d\d · away since \d\d:\d\d \(\d+m\)\nMERGED none\nSTARTED none\nMOVED none\nASKS none open\nUSAGE then 41%/,
    );
    expect(existsSync(join(board, 'away.json'))).toBe(false);
    expect(existsSync(join(board, 'away-last.json'))).toBe(true);
    expect(cli(['back']).err).toMatch(/no away.json/);
  });
  it('back reads what moved while away: merges, starts and lane phases; a bad queue is unknown asks', () => {
    writeFileSync(queueFile(), '{');
    expect(cli(['away']).status).toBe(0);
    const later = new Date(Date.now() + 60e3).toISOString();
    const day = later.slice(0, 10);
    for (const d of ['history', 'lifecycle', 'lanes'])
      mkdirSync(join(board, d), { recursive: true });
    const merged = {
      kind: 'merged',
      pr: 240,
      sha: 'c'.repeat(40),
      mergedAt: later,
      title: 'Board: asks',
    };
    const old = {
      kind: 'merged',
      pr: 1,
      sha: 'd'.repeat(40),
      mergedAt: '2026-01-01T00:00:00Z',
      title: 'old',
    };
    writeFileSync(
      join(board, 'history', `events-${day}.jsonl`),
      [merged, merged, old].map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    writeFileSync(
      join(board, 'lifecycle', 'gate-trims.json'),
      JSON.stringify({ branch: 'gate-trims', startedAt: later }),
    );
    writeFileSync(
      join(board, 'lanes', 'warm-caches.json'),
      JSON.stringify({
        v: 1,
        branch: 'warm-caches',
        phase: 'review',
        phaseSince: later,
        updatedAt: later,
      }),
    );
    const out = cli(['back']).out.split('\n');
    expect(out[1]).toMatch(/^MERGED 1 · PR 240 "Board: asks" \d\d:\d\d$/); // deduped, the old one not since
    expect(out[2]).toMatch(/^STARTED 1 · gate-trims \d\d:\d\d$/);
    expect(out[3]).toMatch(/^MOVED 1 · warm-caches → review \d\d:\d\d$/);
    expect(out[4]).toMatch(/^ASKS unknown \(queue.json bad/);
    for (const d of ['history', 'lifecycle', 'lanes']) rmSync(join(board, d), { recursive: true });
  });
  it('stop writes stop.json, its own file, never pace-control.json; off nulls it; a bad time refuses', () => {
    const ctl = JSON.stringify({ state: 'calm', since: 1, held: ['x'], triggers: [] });
    writeFileSync(join(board, 'pace-control.json'), ctl);
    const at = new Date(Date.now() + 3 * 3600e3).toISOString().slice(11, 16); // TZ=UTC: 3 h ahead
    const lead = new Date(Date.now() + 3 * 3600e3 - 600e3).toISOString().slice(11, 16);
    expect(cli(['stop', at]).out).toMatch(
      new RegExp(
        `^STOP ${at} hard · in \\S+ · pace-watch exits 12 at ${lead}: lanes work until \\d\\d:\\d\\d, then stop clean$`,
      ),
    );
    const c = JSON.parse(readFileSync(join(board, 'stop.json'), 'utf8'));
    expect(new Date(c.stopAt * 1000).toISOString().slice(11, 16)).toBe(at);
    expect(readFileSync(join(board, 'pace-control.json'), 'utf8')).toBe(ctl);
    expect(cli(['stop', 'off']).out).toBe('STOP off');
    expect(JSON.parse(readFileSync(join(board, 'stop.json'), 'utf8')).stopAt).toBeNull();
    expect(cli(['stop', '25:00']).err).toMatch(/want HH:MM/);
    noTmp();
  });
});
