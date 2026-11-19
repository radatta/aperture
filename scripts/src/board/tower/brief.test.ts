import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRIEF_FILE, BRIEF_STALE_MS, briefOut, briefText, type BriefView } from './brief.ts';
import { budgetLine, parseBudget } from '../budget.ts';
import { briefBudget, build, parseArgs, writeBrief } from './web/main.ts';
import { PRS_FILE } from '../lookup.ts';
const ctl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 && c !== '\n'); // a control byte other than newline

const FIXTURES = join(import.meta.dirname, 'fixtures');
const CLI = join(import.meta.dirname, '../cli.ts');
const utc = (t: number) => new Date(t).toISOString().slice(11, 16);
const HEADS = [
  'BRIEF',
  'LANES',
  'SLOTS',
  'MERGE',
  'QUEUED',
  'ASK',
  'ASKS',
  'NEEDS',
  'USAGE',
  'MAC',
  'VM',
  'BUDGET',
  'CTX',
];
const heads = (text: string) =>
  text
    .split('\n')
    .filter((l) => l && !l.startsWith(' '))
    .map((l) => l.split(' ')[0]);

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'brief-'));
  made.push(d);
  return d;
};

let fx: BriefView;
beforeAll(async () => {
  const t = build(parseArgs(['--fixtures', FIXTURES, '--now', '2026-11-08T06:10:00Z']));
  await t.poll(t.clock());
  await t.poll(t.clock()); // the second round reads checks for the PRs the first listed
  fx = { ...t.view(false), usage: { at: t.clock(), text: 'usage: 53% · 9.6%/h · ~4.8 h to 100%' } };
}, 30_000);

describe('briefText on the fixture board', () => {
  it('has every heading once, in order, and ends with a newline', () => {
    const b = briefText(fx, utc);
    expect(heads(b)).toEqual(HEADS);
    expect(b.endsWith('\n')).toBe(true);
    expect(ctl(b)).toBe(false);
  });
  it('carries the facts the hub is asked for', () => {
    const b = briefText(fx, utc);
    expect(b).toMatch(/^BRIEF 06:10 · board \d+m · \d+\?? stale · tower /m);
    expect(b).toMatch(/^LANES \d+ · .*testing/m);
    expect(b).toMatch(/^ {2}bravo-branch +TESTING on dev/m);
    expect(b).toMatch(/^SLOTS dev bravo-branch until \d\d:\d\d · devb juliet-branch until/m);
    expect(b).toMatch(/^QUEUED 3 · 1 ready · 1 held$/m);
    expect(b).toMatch(/^ {2}1 november-branch p0 · after charlie-branch$/m);
    expect(b).toMatch(/^ {2}2 papa-branch p0 · HOLD: /m);
    expect(b).toMatch(/^ {2}2 oscar-branch p1 · ready$/m);
    expect(b).toMatch(/^USAGE 53% · 9\.6%\/h · ~4\.8 h to 100% \(06:10\)$/m);
    expect(b).toMatch(/^MAC AC .* · load [\d. ]+\/\d+/m);
    expect(b).toMatch(/^VM anon [\d.]+G\/[\d.]+G · cpu /m);
    expect(b).toMatch(/^CTX ≥50 /m);
    expect(b).toMatch(/^ASK ~\d\d:\d\d–\d\d:\d\d echo-branch PR$/m);
    expect(b).toMatch(/^NEEDS 3 · india-branch: admit the branch to dev \(\+2\)$/m);
    expect(b).toMatch(/^ASKS 2 · 1 needs your go in a pane$/m);
    expect(b).toMatch(
      /^ {2}d3 Cache key for the warm cache: .* · a\) per branch b\) per lockfile c\) both · pick b$/m,
    );
    expect(b).toMatch(/^ {2}d4 Apply the skills patch to echo-branch · go typed in dispatch$/m);
    expect(b).not.toMatch(/d2 Start golf/); // answered: not open
    expect(b).toMatch(/^MERGE 0 · 1 on hold$/m);
    expect(b).toMatch(/^ {2}HOLD PR 41 charlie-branch ".*": dev: bravo-branch is testing/m);
  });
});

describe('the BUDGET line', () => {
  const limitsPath = new URL('../../../board/limits.json', import.meta.url);
  const shipped = JSON.parse(readFileSync(limitsPath, 'utf8'));

  it('carries the log-only budget’s units, prefix stripped once, and says unknown when there are none', () => {
    const line = budgetLine(
      parseBudget(shipped.budget)!,
      { jobs: 3.8, lanes: 2.6, sessions: 12 },
      { k: 1, why: 'ac' },
    );
    expect(briefText({ ...fx, budget: line }, utc)).toMatch(
      /^BUDGET jobs 3\.8\/6\.5 · lanes 2\.6\/4\.5 · sessions 12\/14 · k 1 ac \(log-only\)$/m,
    );
    expect(briefText({ ...fx, budget: null }, utc)).toMatch(/^BUDGET unknown$/m);
  });

  it('the tower reads it from the board dir, and null without a budget block or a readable limits.json', () => {
    const board = mkdtempSync(join(tmpdir(), 'brief-budget-'));
    expect(briefBudget(board)).toMatch(
      /^budget \(log-only\): jobs 0\.5\/[\d.]+ · lanes 0\.5\/[\d.]+ · sessions 0\/14 · k /,
    );
    const bare = join(board, 'limits.json');
    writeFileSync(bare, JSON.stringify({ ...shipped, budget: undefined }));
    expect(briefBudget(board, bare)).toBeNull();
    expect(briefBudget(board, join(board, 'missing.json'))).toBeNull();
    rmSync(board, { recursive: true });
  });
});

describe('briefText on an empty board', () => {
  const empty = (): BriefView => ({
    ...fx,
    active: [],
    slots: fx.slots.map((s) => ({
      ...s,
      branch: null,
      state: 'free',
      deploying: false,
      live: false,
    })),
    next: { ...fx.next, merge: [], ask: null },
    queued: [],
    asks: [],
    needs: [],
    usage: null,
    ctx: null,
    health: {
      ...fx.health,
      mac: { state: 'missing', at: null, error: null, stats: null },
      container: null,
    },
  });
  it('writes "none" or "unknown" under every heading, never drops one', () => {
    const b = briefText(empty(), utc);
    expect(heads(b)).toEqual(HEADS);
    for (const l of [
      'LANES none',
      'SLOTS dev free · devb free',
      'QUEUED none',
      'ASK none',
      'ASKS none',
      'NEEDS none',
      'USAGE unknown',
      'CTX unknown (no ctx.json)',
    ])
      expect(b.split('\n')).toContain(l);
    expect(b).toMatch(/^MERGE none$/m);
    expect(b).toMatch(/^MAC no stats/m);
    expect(b).toMatch(/^VM no sample/m);
  });
  it('gh unreachable: MERGE says unknown, never none', () => {
    const v = empty();
    v.sources = [
      ...v.sources.filter((s) => s.name !== 'gh PRs'),
      { name: 'gh PRs', state: 'failed', at: null, detail: 'HTTP 502' },
    ];
    expect(briefText(v, utc)).toMatch(/^MERGE unknown \(gh PRs failed: HTTP 502\)$/m);
  });
  it('MERGE ME rows, each PR with its title; HOLD after them with its reason; gh trouble beside real rows', () => {
    const row = fx.active[0]!;
    const me = {
      ...row,
      branch: 'm-lane',
      state: 'MERGE ME' as const,
      pr: { number: 231, title: 'Brief', url: null },
    };
    const hold = {
      ...row,
      branch: 'h-lane',
      state: 'HOLD' as const,
      hold: 'devb busy',
      pr: { number: 232, title: 'T', url: null },
    };
    const v = { ...empty(), next: { ...empty().next, merge: [me, hold] } };
    expect(
      briefText(v, utc)
        .split('\n')
        .filter((l) => /^(MERGE| {2}(PR|HOLD))/.test(l)),
    ).toEqual([
      'MERGE 1 · 1 on hold',
      '  PR 231 m-lane "Brief"',
      '  HOLD PR 232 h-lane "T": devb busy',
    ]);
    v.sources = [
      ...v.sources.filter((x) => x.name !== 'gh PRs'),
      { name: 'gh PRs', state: 'stale', at: null, detail: null },
    ];
    expect(briefText(v, utc)).toMatch(/^MERGE 1 · 1 on hold \(gh PRs stale\)$/m);
  });
  it('a lock held per a stale or failed read says so: the hub pastes the line as fact', () => {
    const v = empty();
    v.slots = [
      { ...fx.slots[0]!, branch: 'x-lane', state: 'unknown', expiresAt: null, live: true },
      fx.slots[1]!,
    ];
    expect(briefText(v, utc)).toMatch(/^SLOTS dev x-lane \(lock unknown\) · /m);
  });
  it('a stale ctx.json reads unknown, a calm one none', () => {
    const v = empty();
    expect(briefText({ ...v, ctx: { at: 0, stale: true, warn: [], bad: [] } }, utc)).toMatch(
      /^CTX unknown \(ctx\.json stale\)$/m,
    );
    expect(briefText({ ...v, ctx: { at: 0, stale: false, warn: [], bad: [] } }, utc)).toMatch(
      /^CTX none over 40%$/m,
    );
  });
  it('more than 5 queued: the first 5 and +n more', () => {
    const q = Array.from({ length: 7 }, (_, i) => ({
      branch: `lane-${i}`,
      order: i,
      cls: 'p1' as const,
      after: [],
      note: null,
      approvedAt: null,
      state: 'ready' as const,
      waitsOn: [],
      line: `${i} lane-${i} p1 · ready`,
    }));
    const b = briefText({ ...empty(), queued: q }, utc);
    expect(b).toMatch(/^QUEUED 7 · 7 ready$/m);
    expect(b).toMatch(/lane-4[\s\S]*\+2 more$/m);
    expect(b).not.toMatch(/lane-5/);
  });
  it('a lane label with control bytes or a huge title is cleaned and capped', () => {
    const r = { ...fx.active[0]!, branch: 'x', label: `BUILDING\u001b[31m ${'y'.repeat(200)}` };
    const b = briefText({ ...empty(), active: [r] }, utc);
    expect(ctl(b)).toBe(false);
    expect(b.split('\n').find((l) => l.startsWith('  x'))!.length).toBeLessThan(90);
  });
});

describe('the brief file and pnpm board brief', () => {
  it('an unreadable queue.json is ASKS unknown, never none', () => {
    expect(briefText({ ...fx, asks: null }, utc)).toMatch(
      /^ASKS unknown \(queue.json unreadable\)$/m,
    );
    const missing = fx.sources.map((x) =>
      x.name === 'queue.json' ? { ...x, state: 'missing' as const } : x,
    );
    expect(briefText({ ...fx, asks: null, sources: missing }, utc)).toMatch(
      /^ASKS unknown \(queue.json missing\)$/m,
    );
  });
  it('writeBrief writes the brief and the PR index by rename, and leaves no tmp file', () => {
    const dir = tmp();
    writeBrief(dir, fx, [
      {
        number: 41,
        title: 't',
        branch: 'charlie-branch',
        state: 'OPEN',
        mergedAt: null,
        createdAt: null,
        sha: null,
        mergeSha: null,
        url: null,
        draft: false,
      },
    ]);
    expect(readdirSync(dir).sort()).toEqual([BRIEF_FILE, PRS_FILE].sort());
    expect(readFileSync(join(dir, BRIEF_FILE), 'utf8')).toMatch(/^BRIEF /);
    expect(JSON.parse(readFileSync(join(dir, PRS_FILE), 'utf8')).prs).toEqual([
      { number: 41, title: 't', branch: 'charlie-branch', state: 'OPEN', url: null },
    ]);
    // pr-index.json is stamped with the list's fetch time; null before gh first answers (wi says so)
    expect(JSON.parse(readFileSync(join(dir, PRS_FILE), 'utf8')).at).toBeNull();
    writeBrief(dir, fx, [], Date.parse('2026-11-08T05:00:00Z'));
    expect(JSON.parse(readFileSync(join(dir, PRS_FILE), 'utf8')).at).toBe(
      '2026-11-08T05:00:00.000Z',
    );
  });
  it('briefOut prints the file; past 180 s it says TOWER DOWN first', () => {
    expect(briefOut('BRIEF x\n', 1000, 1000 + BRIEF_STALE_MS, utc)).toBe('BRIEF x');
    expect(briefOut('BRIEF x\n', 0, BRIEF_STALE_MS + 1, utc)).toMatch(
      /^TOWER DOWN: this brief is from 00:00 .*\nBRIEF x$/,
    );
  });
  it('the verb: fresh file printed, an old one flagged, a missing one refused', () => {
    const dir = tmp();
    const env = { ...process.env, APERTURE_BOARD_DIR: dir };
    const brief = () => spawnSync('node', [CLI, 'brief'], { encoding: 'utf8', env });
    let r = brief();
    expect([r.status, r.stderr]).toEqual([2, expect.stringMatching(/web tower writes it/)]);
    writeFileSync(join(dir, BRIEF_FILE), 'BRIEF 06:10\nLANES none\n');
    r = brief();
    expect([r.status, r.stdout]).toEqual([0, 'BRIEF 06:10\nLANES none\n']);
    const old = Date.now() / 1000 - 600;
    utimesSync(join(dir, BRIEF_FILE), old, old);
    expect(brief().stdout).toMatch(/^TOWER DOWN/);
    expect(spawnSync('node', [CLI, 'brief', 'extra'], { encoding: 'utf8', env }).status).toBe(2);
  });
});
