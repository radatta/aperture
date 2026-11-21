// `pnpm usage`: help and refusals run nothing; report, fit and line on a synthetic usage dir and projects tree.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, usageFor, usageKeys } from '../bot/help.ts';
import {
  DEFAULT_SINCE,
  FLAGS,
  USAGE,
  lensTypes,
  main,
  newestRowTs,
  parseArgs,
  ptMidnight,
  statuslineScript,
} from './cli.ts';
import { cachedPRs, mergedPRs, PR_LIMIT } from './gh.ts';
import { SID, assistantRow, bash, agent, meterRow } from './fixtures.ts';
import { fitModel, hoursTo100, scheduledResets } from './model.ts';
import { boardLine, clock, staleLine } from './report.ts';
import { parseMeter } from './meter.ts';

let tmp: string;
let usage: string;
let projects: string;
const lines: string[] = [];
const out = (s: string) => void lines.push(s);
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-cli-'));
  usage = join(tmp, 'usage');
  projects = join(tmp, 'projects');
  mkdirSync(usage);
  mkdirSync(projects);
  lines.length = 0;
  vi.stubEnv('APERTURE_USAGE_DIR', usage);
  vi.stubEnv('APERTURE_USAGE_PROJECTS', projects);
  vi.stubEnv('APERTURE_LANE_ARCHIVE', join(tmp, 'archive'));
  vi.stubEnv('APERTURE_BOARD_DIR', join(tmp, 'board'));
  vi.stubEnv('APERTURE_CGROUP_DIR', join(tmp, 'cgroup'));
  vi.stubEnv('APERTURE_CLAUDE_DIR', join(tmp, 'claude'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('usage cli … --help and refusals', () => {
  it('covers every USAGE command in FLAGS and back', () => {
    expect(Object.keys(FLAGS).sort()).toEqual(usageKeys(USAGE).sort());
  });

  it.each(commands(USAGE).flatMap((c) => ['--help', '-h'].map((h) => [c, h])))(
    '%s %s → its usage, nothing scanned or written',
    async (c, h) => {
      expect(await main([c, h], out)).toBe(0);
      expect(lines).toEqual([usageFor(USAGE, c)]);
      expect(existsSync(join(usage, 'cache'))).toBe(false);
    },
  );

  it('refuses unknown flags, commands and a rate over the read ceiling, running nothing', async () => {
    expect(await main(['scan', '--bogus'], out)).toBe(2);
    expect(await main(['nope'], out)).toBe(2);
    expect(await main(['scan', '--rate', '200'], out)).toBe(2);
    expect(await main(['report', '--since', 'last-tuesday', '--no-scan'], out)).toBe(2);
    expect(await main(['estimate'], out)).toBe(2);
    expect(await main(['estimate', '--lines', '1.5'], out)).toBe(2);
    expect(await main(['estimate', '--lines', '300', '--lenses', 'correctness,vibes'], out)).toBe(
      2,
    );
    expect(await main(['estimate', '--lines', '300', '--fanout', '-1'], out)).toBe(2);
    expect(existsSync(join(usage, 'cache'))).toBe(false);
  });

  it('maps --lenses names to agent types, defaulting to correctness and tests (and ui with --ui)', () => {
    expect(lensTypes(undefined, false)).toEqual(['review-correctness', 'review-tests']);
    expect(lensTypes(undefined, true)).toEqual(['review-correctness', 'review-tests', 'review-ui']);
    expect(lensTypes('shell,infra,shell', false)).toEqual(['review-shell', 'review-infra']);
    expect(lensTypes('', false)).toEqual([]);
    expect(lensTypes('rules,nope', false)).toBeNull();
    expect(lensTypes('toString', false)).toBeNull(); // own names only, not Object's
  });

  it('estimates offline with no cache from the priors alone, and says so', async () => {
    expect(await main(['estimate', '--lines', '1000', '--ui', '--fanout', '2'], out)).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(
      /^estimate: 1000 lines, ui; lenses: Plan, code-reviewer, review-correctness, review-tests, review-ui; fan-out 2/,
    );
    expect(text).toContain('no usage cache: every constant is a prior');
    expect(text).toContain('÷/× 2.00 prior');
    expect(text).toMatch(/turns ~\d+ \[prior\]/);
    expect(text).toMatch(
      /priors: placeholders \(no .*priors\.json\); a \[prior\] number is invented/,
    );
    expect(existsSync(join(usage, 'cache'))).toBe(false); // offline: no scan, nothing written
  });

  it("takes the usage dir's priors.json over the placeholders, naming what it ignored", async () => {
    // invented values, chosen to differ from the placeholders
    writeFileSync(
      join(usage, 'priors.json'),
      JSON.stringify({
        _source: 'a comment',
        band: 3,
        prices: { Plan: 4 },
        turns: { a: 2, nope: 1 },
        k: { k: 0.2, lo: 0.1, hi: 0.3 },
      }),
    );
    expect(await main(['estimate', '--lines', '1000', '--lenses', ''], out)).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('÷/× 3.00 prior');
    expect(text).toMatch(/Plan 4\.0\*/);
    expect(text).toMatch(/k 0\.2000 \[prior\]/);
    expect(text).toMatch(
      /priors: .*priors\.json; ignored: turns\.nope; still invented placeholders: turns\.bLines, /m,
    );
    expect(text).not.toMatch(/placeholders: [^\n]*turns\.a\b/);
    lines.length = 0;
    writeFileSync(join(usage, 'priors.json'), '{not json');
    expect(await main(['estimate', '--lines', '1000'], out)).toBe(0);
    expect(lines.join('\n')).toMatch(/priors\.json isn't JSON, so placeholders/);
  });

  it('parses flags with values, = and bare', () => {
    expect(parseArgs(['scan', '--rate', '20', '--x=1', '--y'])).toEqual({
      positional: ['scan'],
      flags: { rate: '20', x: '1', y: 'true' },
    });
  });
});

describe('usage cli helpers', () => {
  it('finds the status-line script from the settings command', () => {
    const s = (command: string) => JSON.stringify({ statusLine: { type: 'command', command } });
    expect(statuslineScript(s('bash ~/.claude/sl.sh'), '/home/u')).toBe('/home/u/.claude/sl.sh');
    expect(statuslineScript(s('/opt/sl.sh --x'), '/h')).toBe('/opt/sl.sh');
    expect(statuslineScript('{}', '/h')).toBeNull();
    expect(statuslineScript(null, '/h')).toBeNull();
  });

  it('reads the newest meter row, past a torn last line', () => {
    expect(newestRowTs(usage)).toBeNull();
    writeFileSync(
      join(usage, 'meter-2026-01-04.jsonl'),
      `${meterRow({ ts: '2026-01-04T09:00:00Z' })}\n`,
    );
    writeFileSync(
      join(usage, 'meter-2026-01-05.jsonl'),
      `${meterRow({ ts: '2026-01-05T09:00:00Z' })}\n{"ts":`,
    );
    expect(newestRowTs(usage)).toBe('2026-01-05T09:00:00Z');
  });
});

describe('since and merged PRs', () => {
  it('puts --since at Pacific midnight in either offset', () => {
    expect(new Date(ptMidnight('2026-01-10')).toISOString()).toBe('2026-01-10T08:00:00.000Z');
    expect(new Date(ptMidnight('2026-07-10')).toISOString()).toBe('2026-07-10T07:00:00.000Z');
    // the change days: midnight is still on the old offset
    expect(new Date(ptMidnight('2026-11-01')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(ptMidnight('2026-03-08')).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(ptMidnight('last-tuesday')).toBeNaN();
  });

  const pr = (n: number) => ({
    number: n,
    title: 't',
    headRefName: 'b',
    mergedAt: '2026-01-05T10:00:00Z',
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    files: [{ path: 'a.ts' }],
  });

  it('asks gh for PRs merged since the day, caches by day, and says when it hit the limit', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      const n = calls.length === 1 ? 1 : PR_LIMIT;
      return JSON.stringify(Array.from({ length: n }, (_, i) => pr(i + 1)));
    };
    const cache = join(tmp, 'c');
    const a = await mergedPRs(cache, { since: '2026-01-01', now: 0, gh });
    expect(calls[0]).toContain('merged:>=2025-11-02'); // 60 days back: a reused branch's earlier PR
    expect(a).toMatchObject({ note: null, prs: [{ number: 1, branch: 'b', files: ['a.ts'] }] });
    expect((await mergedPRs(cache, { since: '2026-01-01', now: 60_000, gh })).prs).toHaveLength(1);
    expect(calls).toHaveLength(1); // cached
    const b = await mergedPRs(cache, { since: '2025-12-01', now: 60_000, gh }); // another day refetches
    expect(b.note).toContain('the gh limit');
  });

  it('reads the PR cache offline, and nothing from a missing, torn or foreign one', () => {
    const cache = join(usage, 'cache');
    expect(cachedPRs(cache)).toBeNull();
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'prs.json'), '{"prs":[');
    expect(cachedPRs(cache)).toBeNull();
    writeFileSync(join(cache, 'prs.json'), '{}');
    expect(cachedPRs(cache)).toBeNull();
    writeFileSync(join(cache, 'prs.json'), JSON.stringify({ fetchedAt: 5, prs: [] }));
    expect(cachedPRs(cache)).toEqual({ prs: [], fetchedAt: 5, since: null });
  });

  it('falls back to the cache with a note when gh fails, and fails loud with none', async () => {
    const cache = join(tmp, 'c');
    const bad = async (): Promise<string> => {
      throw new Error('HTTP 502');
    };
    await expect(mergedPRs(cache, { since: '2026-01-01', now: 0, gh: bad })).rejects.toThrow(
      /HTTP 502/,
    );
    await mergedPRs(cache, {
      since: '2026-01-01',
      now: 0,
      gh: async () => JSON.stringify([pr(1)]),
    });
    const r = await mergedPRs(cache, { since: '2026-01-01', now: 5, refresh: true, gh: bad });
    expect(r.stale).toEqual({ newest: 1, fetchedAt: 0, why: 'HTTP 502' });
    expect(r.fetchedAt).toBe(0);
    expect(r.prs).toHaveLength(1);
    // a cache for another --since still stands in, and says whose it is
    const o = await mergedPRs(cache, { since: '2025-12-01', now: 5, gh: bad });
    expect(o.stale?.why).toBe('HTTP 502; the cache is for --since 2026-01-01');
    expect(staleLine(r.stale!)).toMatch(
      /^\*\*PR table stale: newest PR 1, fetched \d\d\/\d\d, \d\d:\d\d PT\*\* \(gh: HTTP 502\)/,
    );
  });

  it('refetches only PRs merged since the cached newest (less a day), keeping the rest', async () => {
    const at = (n: number, iso: string) => ({ ...pr(n), mergedAt: iso });
    const calls: string[][] = [];
    let reply = [at(1, '2026-01-03T10:00:00Z'), at(2, '2026-01-05T01:00:00Z')];
    const gh = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify(reply);
    };
    const cache = join(tmp, 'c');
    await mergedPRs(cache, { since: '2026-01-01', now: 0, gh });
    expect(calls[0]).toContain('merged:>=2025-11-02'); // no cache: the whole lookback
    reply = [
      { ...at(2, '2026-01-05T01:00:00Z'), title: 'refetched' },
      at(3, '2026-01-06T09:00:00Z'),
    ];
    const r = await mergedPRs(cache, { since: '2026-01-01', now: 10, refresh: true, gh });
    expect(calls[1]).toContain('merged:>=2026-01-04'); // PR 2's day less one, in UTC
    expect(r.prs.map((p) => [p.number, p.title])).toEqual([
      [1, 't'],
      [2, 'refetched'],
      [3, 't'],
    ]);
    expect(cachedPRs(cache)).toMatchObject({
      fetchedAt: 10,
      prs: [{ number: 1 }, { number: 2 }, { number: 3 }],
    });
    // past the hour it refetches by itself, still incrementally; another --since starts over
    await mergedPRs(cache, { since: '2026-01-01', now: 10 + 3_600_000, gh });
    expect(calls[2]).toContain('merged:>=2026-01-05');
    await mergedPRs(cache, { since: '2025-12-01', now: 20 + 3_600_000, gh });
    expect(calls[3]).toContain('merged:>=2025-10-02');
    // an incremental page at the gh limit still says so
    reply = Array.from({ length: PR_LIMIT }, (_, i) => at(10 + i, '2026-01-07T00:00:00Z'));
    const full = await mergedPRs(cache, {
      since: '2025-12-01',
      now: 30 + 3_600_000,
      refresh: true,
      gh,
    });
    expect(full.note).toContain('the gh limit');
  });
});

describe('fit model', () => {
  it('splits manual history at weekly resets implied by resets_at', () => {
    const resetsAt = Date.parse('2026-01-15T09:00:00Z') / 1000; // a Thursday 01:00 PT
    const rows = parseMeter(meterRow({ ts: '2026-01-13T10:00:00Z', resetsAt })).rows;
    const manual = {
      readings: [
        { at: '2026-01-07T10:00:00Z', pct: 50 },
        { at: '2026-01-09T10:00:00Z', pct: 20 },
      ],
      resets: [],
    };
    expect(scheduledResets(rows, manual)).toEqual(['2026-01-08T09:00:00.000Z']);
    expect(scheduledResets(rows, { ...manual, resets: ['2026-01-08T09:30:00Z'] })).toEqual([]);
    // a newer resets_at a manual reset moved off schedule marks only its own window's start
    const moved = parseMeter(
      [
        meterRow({ ts: '2026-01-13T10:00:00Z', resetsAt }),
        meterRow({ ts: '2026-01-14T10:00:00Z', resetsAt: resetsAt + 3 * 86400 }),
      ].join('\n'),
    ).rows;
    expect(scheduledResets(moved, manual)).toEqual([
      '2026-01-08T09:00:00.000Z',
      '2026-01-11T09:00:00.000Z',
    ]);
    // a week the log skipped: R and R + 14 d, readings either side of R + 7 d — still split there
    const R = resetsAt * 1000;
    const gap = parseMeter(
      [
        meterRow({ ts: '2026-01-13T10:00:00Z', resetsAt }),
        meterRow({ ts: '2026-01-27T10:00:00Z', resetsAt: resetsAt + 14 * 86400 }),
        meterRow({ ts: '2026-01-27T10:01:00Z', resetsAt: resetsAt + 14 * 86400 + 4 }), // jitter: the same reset
      ].join('\n'),
    ).rows;
    const wide = {
      readings: [...manual.readings, { at: '2026-01-24T10:00:00Z', pct: 30 }],
      resets: [],
    };
    expect(scheduledResets(gap, wide)).toEqual(
      [R - 7 * 86_400_000, R, R + 7 * 86_400_000].map((t) => new Date(t).toISOString()),
    );
    // a manual reset after the previous scheduled one, no rows between: that reset and the manual one are both kept
    const after = parseMeter(
      [
        meterRow({ ts: '2026-01-13T10:00:00Z', resetsAt }), // p = 01-15 09:00
        meterRow({ ts: '2026-01-19T10:00:00Z', resetsAt: resetsAt + 10 * 86400 }), // M + 7 d, M = 01-18
      ].join('\n'),
    ).rows;
    expect(scheduledResets(after, wide)).toEqual([
      '2026-01-08T09:00:00.000Z',
      '2026-01-15T09:00:00.000Z',
      '2026-01-18T09:00:00.000Z',
    ]);
  });

  it('counts hours to 100 from the last tick, crediting at most one point of progress since', () => {
    const h = 3_600_000;
    expect(hoursTo100(96, 0, 6, 0)).toBeCloseTo(4 / 6);
    expect(hoursTo100(96, 0, 6, h / 12)).toBeCloseTo(4 / 6 - 1 / 12);
    expect(hoursTo100(96, 0, 6, h)).toBeCloseTo(3 / 6); // an hour without a tick: one point at most
    expect(hoursTo100(100, 0, 6, 0)).toBe(0);
  });

  it('takes a log of 150k fresh readings without a stack overflow', () => {
    const rows = Array.from({ length: 150_000 }, (_, i) => ({
      ts: i * 1000,
      sid: 's',
      name: null,
      cost: i,
      pct: 1 + Math.floor(i / 10_000),
      resetsAt: 1_800_000_000,
    }));
    expect(() => fitModel({ rows, manual: null, calls: [], now: 150_000_000 })).not.toThrow();
  });

  it('recovers k from live ticks and the calls between them', () => {
    // 1 point per 25 QU, ticks every 10 min, 2.5 QU per minute of calls
    const ts = (m: number) => new Date(Date.UTC(2026, 0, 5, 10, m)).toISOString();
    const meter = Array.from({ length: 13 }, (_, i) =>
      meterRow({ ts: ts(i * 10), sid: 'a', pct: 50 + i, cost: i * 25 }),
    ).join('\n');
    const calls = Array.from({ length: 121 }, (_, m) => ({ ts: Date.parse(ts(m)) + 1, qu: 2.5 }));
    const f = fitModel({
      rows: parseMeter(meter).rows,
      manual: null,
      calls,
      now: Date.parse(ts(120)),
    });
    expect(f.all.kOnly!.k).toBeCloseTo(0.04, 2);
    expect(f.burn.pct).toBe(62);
    expect(f.burn.pctPerHour).toBeCloseTo(6, 6);
    expect(f.live.logRatio).toBeCloseTo(1, 1);
  });
});

describe('stale meter after a reset', () => {
  it('says the meter reset once resets_at passed with no fresh reading', () => {
    const resetsAt = Date.parse('2026-01-05T12:00:00Z') / 1000;
    const meter = [0, 1, 2]
      .map((i) => meterRow({ ts: `2026-01-05T10:0${i}:00Z`, pct: 90 + i, cost: i, resetsAt }))
      .join('\n');
    const f = fitModel({
      rows: parseMeter(meter).rows,
      manual: null,
      calls: [],
      now: Date.parse('2026-01-05T13:00:00Z'),
    });
    expect(f.burn).toMatchObject({
      resetAt: resetsAt * 1000,
      pct: null,
      nextReset: null,
      at: null,
    });
    expect(boardLine(f)).toMatch(/^usage reset .* no reading since$/);
  });

  it('a reset still ahead is burn.nextReset, and burn.at is the newest reading (usage burn reads both)', () => {
    const resetsAt = Date.parse('2026-01-05T12:00:00Z') / 1000;
    const meter = [0, 1, 2]
      .map((i) => meterRow({ ts: `2026-01-05T10:0${i}:00Z`, pct: 90 + i, cost: i, resetsAt }))
      .join('\n');
    const f = fitModel({
      rows: parseMeter(meter).rows,
      manual: null,
      calls: [],
      now: Date.parse('2026-01-05T11:00:00Z'),
    });
    expect(f.burn).toMatchObject({
      resetAt: null,
      pct: 92,
      nextReset: resetsAt * 1000,
      at: Date.parse('2026-01-05T10:02:00Z'),
    });
  });

  it('burn --at refuses a time that is not HH:MM before reading anything', async () => {
    for (const bad of ['25:99', 'soon', '7pm']) {
      lines.length = 0;
      expect(await main(['burn', '--at', bad, '--no-scan'], out)).toBe(2);
      expect(lines.join('\n')).toMatch(/--at takes HH:MM \(24 h\)/);
    }
    expect(existsSync(join(usage, 'cache'))).toBe(false);
  });

  it('labels a rate from k × QU/h as such, not as ticks', () => {
    const resetsAt = Date.parse('2026-01-09T12:00:00Z') / 1000;
    const meter = [0, 1]
      .map((i) => meterRow({ ts: `2026-01-05T10:0${i}:00Z`, pct: 3, cost: i, resetsAt }))
      .join('\n');
    const now = Date.parse('2026-01-05T10:30:00Z');
    const f = fitModel({ rows: parseMeter(meter).rows, manual: null, calls: [], now });
    expect(f.burn).toMatchObject({ resetAt: null, since: null });
  });
});

describe('usage report end to end', () => {
  it('scans a synthetic tree, joins cached PRs, writes report-<day>.md and prints the board line', async () => {
    const P = '-workspace--claude-worktrees-lane-a';
    mkdirSync(join(projects, P), { recursive: true });
    const ts = (m: number) => new Date(Date.UTC(2026, 0, 5, 18, m)).toISOString();
    writeFileSync(
      join(projects, P, `${SID}.jsonl`),
      [
        assistantRow({ id: 'm1', ts: ts(1), tools: [agent('Plan')] }),
        assistantRow({
          id: 'm2',
          ts: ts(5),
          tools: [bash('pnpm board lane review'), agent('code-reviewer')],
        }),
        assistantRow({ id: 'm3', ts: ts(9) }),
      ].join('\n') + '\n',
    );
    // each lane ran a review lens, so both are in the lens regime; lane-z never wrote a phase past plan
    const lens = (proj: string, id: string, type: string, m: number, cwd?: string) => {
      mkdirSync(join(projects, proj, SID, 'subagents'), { recursive: true });
      writeFileSync(
        join(projects, proj, SID, 'subagents', `agent-${id}.jsonl`),
        assistantRow({ id: `${id}-1`, ts: ts(m), cwd }) + '\n',
      );
      writeFileSync(
        join(projects, proj, SID, 'subagents', `agent-${id}.meta.json`),
        JSON.stringify({ agentType: type }),
      );
    };
    lens(P, 'c1', 'review-correctness', 6);
    const Z = '-workspace--claude-worktrees-lane-z';
    const WZ = '/workspace/.claude/worktrees/lane-z';
    mkdirSync(join(projects, Z), { recursive: true });
    writeFileSync(
      join(projects, Z, `${SID}.jsonl`),
      [
        assistantRow({ id: 'z1', ts: ts(20), cwd: WZ, tools: [bash('pnpm -s board lane plan')] }),
        assistantRow({ id: 'z2', ts: ts(25), cwd: WZ, tools: [agent('review-tests')] }),
      ].join('\n') + '\n',
    );
    lens(Z, 't1', 'review-tests', 26, WZ);
    mkdirSync(join(usage, 'cache'), { recursive: true });
    writeFileSync(
      join(usage, 'cache', 'prs.json'),
      JSON.stringify({
        fetchedAt: Date.now(),
        since: '2026-01-01',
        prs: [
          {
            number: 3,
            title: 't',
            branch: 'lane-a',
            mergedAt: Date.parse(ts(10)),
            changedFiles: 3,
            additions: 5,
            deletions: 1,
            files: ['app/a.ts'],
          },
          {
            number: 4,
            title: 'z',
            branch: 'lane-z',
            mergedAt: Date.parse(ts(30)),
            changedFiles: 1,
            additions: 2,
            deletions: 0,
            files: ['scripts/z.ts'],
          },
        ],
      }),
    );
    // lane-a recorded an estimate before its PR merged; lane-q's has no lane file and no PR
    const row = (lane: string, at: string) =>
      JSON.stringify({
        v: 1,
        lane,
        at,
        phase: 'plan',
        inp: { lines: 8, ui: true, lenses: ['review-correctness'], fanout: 0 },
        qu: 2,
        lo: 1,
        hi: 4,
        pct: 0.2,
        pctLo: 0.1,
        pctHi: 0.4,
        basis: { regime: 0, band: 'prior', k: 'prior', priors: 'placeholders' },
      });
    writeFileSync(
      join(usage, 'estimates.jsonl'),
      `${row('lane-a', ts(0))}\n${row('lane-q', ts(2))}\n`,
    );
    expect(await main(['report', '--since', '2026-01-01'], out)).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('## Live estimates');
    expect(text).toMatch(
      /\| lane-a \| [^|]+ \| 8 \(6\) \| yes \| 2\.0 \(1\.0–4\.0\) \| [\d.]+ provisional \|/,
    );
    expect(text).toMatch(/\| lane-q \| .* so far \|/);
    expect(text).toContain('- PR table: newest PR 4, fetched');
    expect(text).not.toContain('PR table stale');
    expect(text).toContain('| 3 | lane-a | small-fix | 3 | 6 | 1 |');
    expect(text).toContain('Not enough data');
    for (const h of [
      '## Where the QU goes',
      '## Turn and context model',
      '## Agent prices',
      '## Backtest',
      '## Phase sources',
    ])
      expect(text).toContain(h);
    // lane-a's review marker rides on its transcript; lane-z only ever wrote plan
    expect(text).toContain('never wrote an explicit phase past plan: 1 (lane-z)');
    expect(text).toMatch(
      /a `pnpm board lane` marker (\d+)% · the phase log 0% · heuristics \d+% · nothing \d+%/,
    );
    expect(Number(/marker (\d+)%/.exec(text)![1])).toBeGreaterThan(0);
    expect(text).toContain('Phase-log rows read: 0.');
    expect(text).toMatch(/- priors: placeholders/);
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    expect(readFileSync(join(usage, `report-${day}.md`), 'utf8')).toContain('## PR table');
    lines.length = 0;
    expect(await main(['line', '--no-scan'], out)).toBe(0);
    expect(lines).toEqual(['usage –']);
    // the score: the same table, the lane's own paste line, and lane-q's gap
    lines.length = 0;
    // score takes the cache's older --since as its own, so it never refetches it (gh would fail here)
    const down = async (): Promise<string> => {
      throw new Error('HTTP 504');
    };
    expect(await main(['score', '--no-scan', '--lane', 'lane-a'], out, { gh: down })).toBe(0);
    const sc = lines.join('\n');
    expect(sc).not.toContain('PR table stale');
    expect(sc).toContain('- PR table: newest PR 4, fetched');
    expect(sc).not.toContain('| lane-q');
    expect(sc).toMatch(
      /^usage \(local only, never pasted\): estimate 2\.0 QU \(1\.0–4\.0\) at 8 lines; provisional [\d.]+ QU \(×[\d.]+\), PR 3$/m,
    );
    expect(sc).toMatch(/- lane-q: estimated .* no lane file and no merged PR after it/);
    // a report for a later --since with gh down: the stale header, and its estimates before --since left out
    lines.length = 0;
    expect(await main(['report', '--no-scan', '--since', '2026-01-06'], out, { gh: down })).toBe(0);
    const rp = lines.join('\n');
    expect(rp).toMatch(
      /^\*\*PR table stale: newest PR 4, fetched .* \(gh: HTTP 504; the cache is for --since 2026-01-01\)/,
    );
    expect(rp).toContain('- PR table: STALE: newest PR 4');
    expect(rp).toContain(
      "- 2 estimates before this report's --since left out: pnpm usage score has them.",
    );
  });
});

describe('the estimate ledger: estimate --lane and score', () => {
  const board = () => join(tmp, 'board');
  const laneFile = (branch: string, phase: string) => {
    mkdirSync(join(board(), 'lanes'), { recursive: true });
    writeFileSync(
      join(board(), 'lanes', `${branch}.json`),
      JSON.stringify({ v: 1, branch, phase, updatedAt: '2026-01-05T10:00:00Z' }),
    );
  };
  const ledger = () => join(usage, 'estimates.jsonl');
  const run = async (...argv: string[]) => {
    lines.length = 0;
    const code = await main(argv, out);
    return { code, text: lines.join('\n') };
  };

  it('records an estimate for a lane with a lane file, and a re-estimate as a second row', async () => {
    laneFile('lane-a', 'plan');
    const a = await run(
      'estimate',
      '--lines',
      '300',
      '--lenses',
      'correctness,shell',
      '--lane',
      'lane-a',
    );
    expect(a.code).toBe(0);
    expect(a.text).toMatch(
      /^estimate: 300 lines; lenses: Plan, code-reviewer, review-correctness, review-shell/,
    );
    expect(a.text).toMatch(/recorded: .*estimates\.jsonl \(lane lane-a, estimate 1 this cycle\)$/);
    laneFile('lane-a', 'review');
    const b = await run('estimate', '--lines', '500', '--lane', 'lane-a');
    expect(b.text).toMatch(/estimate 2 this cycle, late: phase review\)$/);
    const rows = readFileSync(ledger(), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      v: 1,
      lane: 'lane-a',
      phase: 'plan',
      inp: { lines: 300, ui: false, lenses: ['review-correctness', 'review-shell'], fanout: 0 },
      basis: { band: 'prior', k: 'prior', priors: 'placeholders' },
    });
    expect(rows[0].lo).toBeLessThanOrEqual(rows[0].qu);
    expect(rows[1]).toMatchObject({ phase: 'review', inp: { lines: 500 } });
  });

  it('refuses a lane with no lane file or a bad name, writing nothing; without --lane writes nothing', async () => {
    expect((await run('estimate', '--lines', '300', '--lane', 'lane-x')).text).toContain(
      'no lane file at',
    );
    expect((await run('estimate', '--lines', '300', '--lane', 'Lane X')).code).toBe(2);
    expect((await run('estimate', '--lines', '300', '--lane')).code).toBe(2);
    expect((await run('estimate', '--lines', '300')).code).toBe(0);
    expect(existsSync(ledger())).toBe(false);
  });

  it('creates a missing usage dir, mends a torn last line, and says NOT RECORDED when it cannot write', async () => {
    laneFile('lane-a', 'plan');
    rmSync(usage, { recursive: true });
    expect((await run('estimate', '--lines', '300', '--lane', 'lane-a')).code).toBe(0);
    writeFileSync(ledger(), `${readFileSync(ledger(), 'utf8')}{"v":1,"lane":"lane-a","at":"2026`);
    expect((await run('estimate', '--lines', '300', '--lane', 'lane-a')).code).toBe(0);
    const text = readFileSync(ledger(), 'utf8');
    expect(text.split('\n').filter((l) => l.startsWith('{') && l.endsWith('}'))).toHaveLength(2);
    expect((await run('score', '--check')).text).toBe(
      'gap: estimates.jsonl: unreadable row at line 2 → delete it by hand (a torn append; the rest is read)',
    );
    rmSync(ledger());
    mkdirSync(ledger()); // a directory where the file goes: the append fails
    const bad = await run('estimate', '--lines', '300', '--lane', 'lane-a');
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(/^estimate: 300 lines/); // the estimate still shows
    expect(bad.text).toMatch(/NOT RECORDED: /);
  });

  it('check: exit 1 on a lane past plan with no estimate, 0 once recorded; loads no cache', async () => {
    laneFile('lane-a', 'build');
    const g = await run('score', '--check');
    expect(g).toEqual({
      code: 1,
      text: 'gap: lane-a: no usage estimate (phase build) → pnpm usage estimate --lane lane-a --lines <n> [--ui] --lenses <…>',
    });
    await run('estimate', '--lines', '300', '--lane', 'lane-a');
    expect(await run('score', '--check')).toEqual({ code: 0, text: 'estimates: no gaps' });
    expect(existsSync(join(usage, 'cache'))).toBe(false);
  });

  it('void closes an abandoned estimate, and wants a lane and a reason', async () => {
    laneFile('lane-a', 'plan');
    await run('estimate', '--lines', '300', '--lane', 'lane-a');
    rmSync(join(board(), 'lanes', 'lane-a.json')); // lanes end, no PR
    expect((await run('score', '--check')).code).toBe(1);
    expect((await run('score', '--lane', 'lane-a', '--void')).code).toBe(2);
    expect((await run('score', '--void', 'gone')).code).toBe(2);
    const v = await run('score', '--lane', 'lane-a', '--void', 'scope moved to another lane');
    expect(v.text).toMatch(/^voided: lane-a's open estimate \(scope moved to another lane\)/);
    expect(await run('score', '--check')).toEqual({ code: 0, text: 'estimates: no gaps' });
  });

  it('score --refresh with gh failing heads the output with the stale table', async () => {
    mkdirSync(join(usage, 'cache'), { recursive: true });
    writeFileSync(
      join(usage, 'cache', 'prs.json'),
      JSON.stringify({ fetchedAt: 0, since: DEFAULT_SINCE, prs: [] }),
    );
    lines.length = 0;
    const gh = async (): Promise<string> => {
      throw new Error('HTTP 504 Gateway Timeout');
    };
    expect(await main(['score', '--no-scan', '--refresh'], out, { gh })).toBe(0);
    expect(lines.join('\n')).toMatch(
      /^\*\*PR table stale: newest PR none, fetched .* \(gh: HTTP 504 Gateway Timeout\)/,
    );
    expect(lines.join('\n')).toContain('- PR table: STALE: newest PR none');
    expect(lines.join('\n')).toContain('No estimates recorded');
  });

  it('score with gh failing and no PR cache says so first and exits 1', async () => {
    const gh = async (): Promise<string> => {
      throw new Error('HTTP 502');
    };
    const r = await (async () => {
      lines.length = 0;
      const code = await main(['score', '--no-scan'], out, { gh });
      return { code, text: lines.join('\n') };
    })();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(
      /^\*\*No PR table: gh failed \(.*HTTP 502.*\) and there is no cache\/prs\.json\.\*\*/,
    );
    expect(r.text).toContain('- PR table: none: ');
  });

  it('refuses --check with other flags, and a void with nothing open', async () => {
    for (const f of [['--lane', 'lane-a'], ['--refresh'], ['--void', 'x']])
      expect((await run('score', '--check', ...f)).code).toBe(2);
    expect(existsSync(ledger())).toBe(false);
    const none = await run('score', '--lane', 'lane-a', '--void', 'gone');
    expect(none).toEqual({
      code: 2,
      text: '--void: lane-a has no open estimate (none recorded, already voided, or its PR merged)',
    });
    laneFile('lane-a', 'plan');
    await run('estimate', '--lines', '300', '--lane', 'lane-a');
    expect((await run('score', '--lane', 'lane-a', '--void', 'gone')).code).toBe(0);
    expect((await run('score', '--lane', 'lane-a', '--void', 'again')).code).toBe(2); // already voided
    expect(readFileSync(ledger(), 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  it("refuses --lane once the lane's own PR merged, and the check stays quiet", async () => {
    const merged = Date.parse('2026-01-05T09:00:00Z');
    const prs = (n: number) => ({
      fetchedAt: merged,
      since: DEFAULT_SINCE,
      prs: [
        {
          number: n,
          title: 't',
          branch: 'lane-a',
          mergedAt: merged,
          changedFiles: 1,
          additions: 1,
          deletions: 0,
          files: [],
        },
      ],
    });
    mkdirSync(join(usage, 'cache'), { recursive: true });
    writeFileSync(join(usage, 'cache', 'prs.json'), JSON.stringify(prs(9)));
    mkdirSync(join(board(), 'lanes'), { recursive: true });
    const file = (phase: string) =>
      writeFileSync(
        join(board(), 'lanes', 'lane-a.json'),
        JSON.stringify({ v: 1, branch: 'lane-a', phase, pr: 9, updatedAt: '2026-01-05T10:00:00Z' }),
      );
    file('pr');
    const r = await run('estimate', '--lines', '300', '--lane', 'lane-a');
    expect(r.code).toBe(2);
    expect(r.text).toMatch(
      /^--lane lane-a: its PR 9 merged 01\/05, 01:00 PT, so an estimate now would count/,
    );
    expect(existsSync(ledger())).toBe(false);
    expect(await run('score', '--check')).toEqual({ code: 0, text: 'estimates: no gaps' });
    expect((await run('score', '--lane', 'lane-a', '--void', 'gone')).text).toBe(
      '--void: lane-a has no open estimate: its PR 9 merged, and the estimate is scored against it',
    );
    file('plan'); // a new cycle on the name starts in plan
    expect((await run('estimate', '--lines', '300', '--lane', 'lane-a')).code).toBe(0);
  });

  it("score reuses a cache whose list reaches back to its cut, and never cuts its table by the cache's since", async () => {
    const t = Date.parse(`${DEFAULT_SINCE}T12:00:00Z`);
    const gh = vi.fn(async (): Promise<string> => {
      throw new Error('HTTP 504');
    });
    const write = (since: string, mergedAt: number) => {
      mkdirSync(join(usage, 'cache'), { recursive: true });
      writeFileSync(
        join(usage, 'cache', 'prs.json'),
        JSON.stringify({
          fetchedAt: Date.now(),
          since,
          prs: [
            {
              number: 5,
              title: 't',
              branch: 'lane-b',
              mergedAt,
              changedFiles: 1,
              additions: 9,
              deletions: 0,
              files: [],
            },
          ],
        }),
      );
    };
    const later = new Date(t + 10 * 86_400_000).toISOString().slice(0, 10);
    write(later, t + 86_400_000);
    expect(await main(['score', '--no-scan'], out, { gh })).toBe(0);
    expect(gh).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(usage, 'cache', 'prs.json'), 'utf8')).since).toBe(later);
    // an older since is reused too, but a PR merged before the default since stays out of the score's table
    const older = new Date(t - 20 * 86_400_000).toISOString().slice(0, 10);
    write(older, t - 5 * 86_400_000);
    lines.length = 0;
    expect(await main(['score', '--no-scan'], out, { gh })).toBe(0);
    expect(gh).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Merged since the first estimate with none: none.');
    expect(lines.join('\n')).not.toContain('PR table stale');
  });

  it('treats an unreadable prs.json as no cache: a good fetch rewrites it, a failed one says so', async () => {
    mkdirSync(join(usage, 'cache'), { recursive: true });
    const path = join(usage, 'cache', 'prs.json');
    writeFileSync(path, '{"fetchedAt":');
    const down = async (): Promise<string> => {
      throw new Error('HTTP 502');
    };
    await expect(
      mergedPRs(join(usage, 'cache'), { since: '2026-01-01', now: 1, gh: down }),
    ).rejects.toThrow('gh failed (HTTP 502) and cache/prs.json is unreadable');
    lines.length = 0;
    expect(await main(['score', '--no-scan'], out, { gh: down })).toBe(1);
    expect(lines.join('\n')).toMatch(
      /^\*\*No PR table: gh failed \(HTTP 502\) and cache\/prs\.json is unreadable\.\*\*/,
    );
    const up = async (): Promise<string> => '[]';
    expect(
      (await mergedPRs(join(usage, 'cache'), { since: '2026-01-01', now: 1, gh: up })).prs,
    ).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ since: '2026-01-01', prs: [] });
  });

  it('records a torn lane file as phase unknown, and counts re-estimates per cycle on a reused name', async () => {
    const t0 = Date.parse('2026-01-05T10:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      mkdirSync(join(board(), 'lanes'), { recursive: true });
      writeFileSync(join(board(), 'lanes', 'lane-a.json'), '{"v":1,"bra');
      expect((await run('estimate', '--lines', '300', '--lane', 'lane-a')).text).toMatch(
        /\(lane lane-a, estimate 1 this cycle\)$/,
      );
      expect(JSON.parse(readFileSync(ledger(), 'utf8')).phase).toBeNull();
      // PR 9 merged on lane-a an hour later: the next estimate on the name starts the count again
      mkdirSync(join(usage, 'cache'), { recursive: true });
      const pr = {
        number: 9,
        title: 't',
        branch: 'lane-a',
        changedFiles: 1,
        additions: 1,
        deletions: 0,
        files: [],
      };
      writeFileSync(
        join(usage, 'cache', 'prs.json'),
        JSON.stringify({
          fetchedAt: t0,
          since: DEFAULT_SINCE,
          prs: [{ ...pr, mergedAt: t0 + 3_600_000 }],
        }),
      );
      vi.setSystemTime(t0 + 2 * 3_600_000);
      laneFile('lane-a', 'plan');
      expect((await run('estimate', '--lines', '300', '--lane', 'lane-a')).text).toMatch(
        /\(lane lane-a, estimate 1 this cycle\)$/,
      );
      expect((await run('estimate', '--lines', '400', '--lane', 'lane-a')).text).toMatch(
        /\(lane lane-a, estimate 2 this cycle\)$/,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('small things', () => {
  it('defines --ui by the paths the fit counts', () => {
    expect(USAGE).toContain('whether it touches app/ or extension/ (--ui)');
    expect(USAGE).not.toContain('browser');
  });
  it('prints the hour after midnight PT as 00, never 24', () => {
    expect(clock(Date.parse('2026-01-05T08:00:00Z'))).toBe('01/05, 00:00');
    expect(clock(Date.parse('2026-01-05T08:30:00Z'))).toBe('01/05, 00:30');
  });
});
