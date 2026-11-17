// `pnpm usage`: help and refusals run nothing; report, fit and line on a synthetic usage dir and projects tree.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, usageFor, usageKeys } from '../bot/help.ts';
import { FLAGS, USAGE, main, newestRowTs, parseArgs, ptMidnight, statuslineScript } from './cli.ts';
import { mergedPRs, PR_LIMIT } from './gh.ts';
import { SID, assistantRow, bash, agent, meterRow } from './fixtures.ts';
import { fitModel, hoursTo100, scheduledResets } from './model.ts';
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
    expect(existsSync(join(usage, 'cache'))).toBe(false);
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
    expect(calls[0]).toContain('merged:>=2026-01-01');
    expect(a).toMatchObject({ note: null, prs: [{ number: 1, branch: 'b', files: ['a.ts'] }] });
    expect((await mergedPRs(cache, { since: '2026-01-01', now: 60_000, gh })).prs).toHaveLength(1);
    expect(calls).toHaveLength(1); // cached
    const b = await mergedPRs(cache, { since: '2025-12-01', now: 60_000, gh }); // another day refetches
    expect(b.note).toContain('the gh limit');
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
    const r = await mergedPRs(cache, { since: '2026-01-01', now: 0, refresh: true, gh: bad });
    expect(r.note).toContain('gh failed');
    expect(r.prs).toHaveLength(1);
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
  });

  it('counts hours to 100 from the last tick, crediting at most one point of progress since', () => {
    const h = 3_600_000;
    expect(hoursTo100(96, 0, 6, 0)).toBeCloseTo(4 / 6);
    expect(hoursTo100(96, 0, 6, h / 12)).toBeCloseTo(4 / 6 - 1 / 12);
    expect(hoursTo100(96, 0, 6, h)).toBeCloseTo(3 / 6); // an hour without a tick: one point at most
    expect(hoursTo100(100, 0, 6, 0)).toBe(0);
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
        ],
      }),
    );
    expect(await main(['report', '--since', '2026-01-01'], out)).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('| 3 | lane-a | small-fix | 3 | 6 | 1 |');
    expect(text).toContain('Not enough data');
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    expect(readFileSync(join(usage, `report-${day}.md`), 'utf8')).toContain('## PR table');
    lines.length = 0;
    expect(await main(['line', '--no-scan'], out)).toBe(0);
    expect(lines).toEqual(['usage –']);
  });
});
