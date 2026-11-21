// `pnpm usage <command>`: the usage cost model (docs/ops/USAGE-METER.md). Data lives in the gitignored usage dir;
// nothing here writes a tracked file. Plain `node` (Node 22 strips types): erasable syntax, node: builtins only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliGuard } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { parseMeter, type Manual, type MeterRow } from './meter.ts';
import { cachedPRs, ghText, mergedPRs, type GhText, type PR, type Stale } from './gh.ts';
import { estimateBasis, fitModel, reportModel } from './model.ts';
import { DEFAULT_PRIORS, LENSES, mergePriors, predict, type Priors } from './estimate.ts';
import { parsePhaseLog } from './phaselog.ts';
import { attribute, overhead, prTable } from './prs.ts';
import type { JobEvent } from './questions.ts';
import {
  boardLine,
  estimateLines,
  fitLines,
  reportLines,
  scoreLines,
  staleLine,
} from './report.ts';
import {
  LEDGER,
  current,
  formatRow,
  gaps,
  liveScore,
  parseLedger,
  prTableBasis,
  type EstRow,
  type LedgerRow,
} from './ledger.ts';
import { BRANCH_RE, isProblem, parseLane, readLanes } from '../board/tower/lanes.ts';
import { burnLines } from './burn.ts';
import { stopAt } from '../board/away.ts';
import { anonBytes, scan } from './scan.ts';
import { loadCache, writeAtomic } from './store.ts';

export const USAGE = `pnpm usage <command>   (-h / --help on any command: its usage; nothing runs)
  scan [--rate <MB/s>]          read new transcript bytes into the cache (rate-limited, resumable)
  report [--since <YYYY-MM-DD>] [--refresh] [--no-scan]
                                the full model: k, burn, per PR type and phase, drivers, overhead, the two
                                measure-first questions; also writes <usage dir>/report-<day>.md
  fit [--no-scan]               k (meter % per QU) with its interval, the holdout, burn now
  line [--no-scan]              one line: usage % · %/h · hours to 100
  burn [--at <HH:MM>] [--no-scan]
                                usage now and where it lands at the reset (and at HH:MM), low–high (the hub's /burn)
  estimate --lines <n> [--ui] [--lenses <a,b,…>] [--fanout <n>] [--lane <branch>] [--scan]
                                a task's QU and meter %, low–high, from its diff lines, a browser/device check (--ui),
                                its review lenses (rules correctness tests shell infra ui extension; Plan and rules always;
                                default correctness,tests, plus ui with --ui) and fan-out agents; offline from the cache;
                                --lane records it in <usage dir>/estimates.jsonl (the lane's fixed step after Plan)
  score [--lane <branch>] [--refresh] [--no-scan]
                                the recorded estimates against their PRs' actual QU: the live score
  score --check                 the fixed step's gaps, from the ledger, lane files and cached PRs only; exit 1 on any
  score --lane <branch> --void <reason>
                                close an abandoned lane's estimate
  doctor                        is the meter logger installed and writing?`;

export const FLAGS: Record<string, Spec> = {
  scan: { flags: ['rate'] },
  report: { flags: ['since'], bare: ['refresh', 'no-scan'] },
  fit: { bare: ['no-scan'] },
  line: { bare: ['no-scan'] },
  burn: { flags: ['at'], bare: ['no-scan'] },
  estimate: { flags: ['lines', 'lenses', 'fanout', 'lane'], bare: ['ui', 'scan'] },
  score: { flags: ['lane', 'void'], bare: ['check', 'refresh', 'no-scan'] },
  doctor: {},
};

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [k = '', v] = a.slice(2).split('=', 2);
    const next = argv[i + 1];
    if (v !== undefined) flags[k] = v;
    else if (next !== undefined && !next.startsWith('--')) {
      flags[k] = next;
      i++;
    } else flags[k] = 'true';
  }
  return { positional, flags };
}

export const env = (e: NodeJS.ProcessEnv = process.env) => {
  const usageDir = e.APERTURE_USAGE_DIR ?? '/workspace/localNotes/usage';
  return {
    usageDir,
    cache: join(usageDir, 'cache'),
    projects: e.APERTURE_USAGE_PROJECTS ?? join(homedir(), '.claude', 'projects'),
    cgroup: e.APERTURE_CGROUP_DIR ?? '/sys/fs/cgroup',
    claudeDir: e.APERTURE_CLAUDE_DIR ?? join(homedir(), '.claude'),
    archive: e.APERTURE_LANE_ARCHIVE ?? '/workspace/localNotes/archive',
    board: e.APERTURE_BOARD_DIR ?? '/workspace/localNotes/board',
  };
};

const MAX_RATE = 60; // MB/s: the ceiling the COI read detector leaves (docs/ops/USAGE-METER.md → Scan)
const ANON_LIMIT = 10 * 1024 ** 3;
const readOr = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

export function newestRowTs(usageDir: string): string | null {
  const days = existsSync(usageDir)
    ? readdirSync(usageDir)
        .filter((f) => /^meter-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
    : [];
  const last = days.at(-1);
  if (!last) return null;
  const rows = readFileSync(join(usageDir, last), 'utf8').trimEnd().split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(rows[i]!).ts ?? null;
    } catch {
      // torn last line
    }
  }
  return null;
}

// The script the statusLine command runs: `bash <path>` or the path itself, ~ expanded.
export function statuslineScript(settings: string | null, home: string): string | null {
  try {
    const cmd: string = JSON.parse(settings ?? '').statusLine?.command ?? '';
    const path = /(?:^|\s)(~?\/[^\s]+\.sh)\b/.exec(cmd)?.[1];
    return path ? path.replace(/^~/, home) : null;
  } catch {
    return null;
  }
}

export function readMeter(usageDir: string): { rows: MeterRow[]; bad: number } {
  const files = existsSync(usageDir)
    ? readdirSync(usageDir)
        .filter((f) => /^meter-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
    : [];
  const rows: MeterRow[] = [];
  let bad = 0;
  for (const f of files) {
    const p = parseMeter(readFileSync(join(usageDir, f), 'utf8'));
    for (const r of p.rows) rows.push(r);
    bad += p.bad;
  }
  rows.sort((x, y) => x.ts - y.ts);
  return { rows, bad };
}

// Midnight Pacific on a YYYY-MM-DD, in whichever offset (PST or PDT) that day has.
export function ptMidnight(day: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(utc)) return NaN;
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(utc + 8 * 3_600_000) // 00:00 PST / 01:00 PDT: the day's own offset, change days included
    .find((p) => p.type === 'timeZoneName')?.value;
  const h = Number(/GMT([+-]\d+)/.exec(name ?? '')?.[1] ?? -8);
  return utc - h * 3_600_000;
}

export function readManual(usageDir: string): Manual | null {
  try {
    const m = JSON.parse(readFileSync(join(usageDir, 'manual-readings.json'), 'utf8'));
    return { readings: m.readings ?? [], resets: m.resets ?? [] };
  } catch {
    return null;
  }
}

const HUB_JSON = join(import.meta.dirname, '../../board/hub.json');
export const hubName = () => {
  try {
    return String(JSON.parse(readFileSync(HUB_JSON, 'utf8')).name);
  } catch {
    return 'dispatch';
  }
};

// Archived lane reports (localNotes/archive/<lane>/report-<lane>.md), by lane, for the review-round question.
export function readReports(archive: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const lane of existsSync(archive) ? readdirSync(archive) : []) {
    const p = join(archive, lane, `report-${lane}.md`);
    if (existsSync(p)) out.set(lane, readFileSync(p, 'utf8'));
  }
  return out;
}

export function readEvents(board: string): JobEvent[] {
  const dir = join(board, 'history');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^events-.*\.jsonl$/.test(f)) : [];
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l) as JobEvent] : [];
        } catch {
          return [];
        }
      }),
  );
}

export const DEFAULT_SINCE = '2026-11-04';

export const readPhaseLog = (usageDir: string) =>
  parsePhaseLog(readOr(join(usageDir, 'phase-log.jsonl')) ?? '');

// The usage dir's priors.json over the placeholder defaults (estimate.ts → DEFAULT_PRIORS), and a note saying which
// it used: the placeholders aren't a fit, so their estimate is never shown as one.
export function readPriors(usageDir: string): { priors: Priors; note: string; fromFile: boolean } {
  const path = join(usageDir, 'priors.json');
  const text = readOr(path);
  if (text === null)
    return {
      priors: DEFAULT_PRIORS,
      note: `priors: placeholders (no ${path}); a [prior] number is invented, not a fit`,
      fromFile: false,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      priors: DEFAULT_PRIORS,
      note: `priors: ${path} isn't JSON, so placeholders; a [prior] number is invented, not a fit`,
      fromFile: false,
    };
  }
  const { priors, bad, placeholders } = mergePriors(raw);
  return {
    priors,
    fromFile: true,
    note: [
      `priors: ${path}`,
      ...(bad.length ? [`ignored: ${bad.join(', ')}`] : []),
      ...(placeholders.length ? [`still invented placeholders: ${placeholders.join(', ')}`] : []),
    ].join('; '),
  };
}

// --lenses a,b → agent types; null on an unknown name.
export function lensTypes(spec: string | undefined, ui: boolean): string[] | null {
  const names =
    spec === undefined
      ? ['correctness', 'tests', ...(ui ? ['ui'] : [])]
      : spec.split(',').filter(Boolean);
  const types = names.map((n) => (Object.hasOwn(LENSES, n.trim()) ? LENSES[n.trim()] : undefined));
  return types.every((t): t is string => !!t) ? [...new Set(types)] : null;
}

export function readLedger(usageDir: string): { rows: LedgerRow[]; bad: number[] } {
  const text = readOr(join(usageDir, LEDGER));
  return text === null ? { rows: [], bad: [] } : parseLedger(text);
}

// One append per row; a torn last line (an append cut short) gets its newline first, so the new row stays whole.
export function appendLedger(usageDir: string, row: LedgerRow): string {
  const path = join(usageDir, LEDGER);
  mkdirSync(usageDir, { recursive: true });
  const prev = readOr(path);
  appendFileSync(path, `${prev && !prev.endsWith('\n') ? '\n' : ''}${formatRow(row)}\n`);
  return path;
}

// The fixed step's check, for `score --check` and the hub's pq-check (docs/ops/HUB.md → Usage estimates): never
// loads the transcript cache, never fetches.
export function estimateGaps(e: ReturnType<typeof env> = env()): string[] {
  const { rows, bad } = readLedger(e.usageDir);
  const { lanes, problems } = readLanes(e.board);
  return gaps({ rows, bad, lanes, problems, prs: cachedPRs(e.cache) });
}

// --lane: a branch name with a lane file (a typo would record an estimate no lane ever clears).
type LaneArg = { error: string } | { lane: string; phase: string | null };
function laneArg(lane: string | undefined, board: string, needFile: boolean): LaneArg {
  if (lane === undefined || !BRANCH_RE.test(lane))
    return { error: '--lane takes a lane branch name' };
  const p = join(board, 'lanes', `${lane}.json`);
  const text = readOr(p);
  if (text === null)
    return needFile
      ? { error: `--lane ${lane}: no lane file at ${p} (the lane writes it with pnpm board lane)` }
      : { lane, phase: null };
  const f = parseLane(text, `${lane}.json`);
  return { lane, phase: isProblem(f) ? null : f.phase };
}

async function scanQuiet(e: ReturnType<typeof env>, out: (s: string) => void) {
  await scan({
    root: e.projects,
    cache: e.cache,
    maxBps: 40e6,
    memoryOk: () => (anonBytes(e.cgroup) ?? 0) < ANON_LIMIT,
    log: out,
  });
}

async function score(
  flags: Record<string, string>,
  e: ReturnType<typeof env>,
  out: (s: string) => void,
  deps: { gh: GhText },
): Promise<number> {
  if (flags.check && (flags.void !== undefined || flags.lane !== undefined || flags.refresh)) {
    out(
      '--check takes no other flag: it reads the ledger, the lane files and cache/prs.json as they are',
    );
    return 2;
  }
  if (flags.void !== undefined) {
    const rec = laneArg(flags.lane, e.board, false);
    if ('error' in rec) {
      out(rec.error);
      return 2;
    }
    if (flags.void === 'true' || !flags.void.trim()) {
      out('--void takes the reason the lane was abandoned');
      return 2;
    }
    const open = current(readLedger(e.usageDir).rows, cachedPRs(e.cache)?.prs ?? []).find(
      (x) => x.lane === rec.lane && !x.pr && x.row && !x.voided,
    );
    if (!open) {
      out(
        `--void: ${rec.lane} has no open estimate (none recorded, already voided, or its PR merged)`,
      );
      return 2;
    }
    const path = appendLedger(e.usageDir, {
      v: 1,
      lane: rec.lane,
      at: Date.now(),
      void: flags.void,
    });
    out(`voided: ${rec.lane}'s open estimate (${flags.void}) in ${path}`);
    return 0;
  }
  if (flags.check) {
    const g = estimateGaps(e);
    out(g.length ? g.map((l) => `gap: ${l}`).join('\n') : 'estimates: no gaps');
    return g.length ? 1 : 0;
  }
  if (flags.lane !== undefined && !BRANCH_RE.test(flags.lane)) {
    out('--lane takes a lane branch name');
    return 2;
  }
  if (!flags['no-scan']) await scanQuiet(e, () => {});
  const now = Date.now();
  let prs: PR[] = [];
  let stale: Stale | null = null;
  let fetchedAt: number | null = null;
  let table: string;
  let failed: string | null = null;
  // the cache's own --since when it reaches back further, so score and an older report never refetch in turn
  const cs = cachedPRs(e.cache)?.since;
  const since = cs && cs < DEFAULT_SINCE && /^\d{4}-\d{2}-\d{2}$/.test(cs) ? cs : DEFAULT_SINCE;
  try {
    const r = await mergedPRs(e.cache, {
      since,
      refresh: !!flags.refresh,
      now,
      gh: deps.gh,
    });
    prs = r.prs;
    stale = r.stale;
    fetchedAt = r.fetchedAt;
    table = prTableBasis(prs, r.fetchedAt, stale);
  } catch (err) {
    failed = (err as Error).message;
    table = `none: ${failed}`;
  }
  const loaded = loadCache(e.cache);
  const a = attribute(loaded, hubName(), readPhaseLog(e.usageDir));
  const ledger = readLedger(e.usageDir);
  const rows = prTable(a, prs, Math.min(ptMidnight(since), ...ledger.rows.map((r) => r.at)));
  const pr = readPriors(e.usageDir);
  const fit = fitModel({
    rows: readMeter(e.usageDir).rows,
    manual: readManual(e.usageDir),
    calls: loaded.calls,
    now,
  });
  const { units } = estimateBasis(rows, fit, pr.priors);
  const s = liveScore({
    ledger,
    prs,
    rows,
    calls: a.calls,
    units,
    lastCall: loaded.calls.at(-1)?.ts ?? null,
  });
  const { lanes, problems } = readLanes(e.board);
  const g = gaps({
    ...ledger,
    lanes,
    problems,
    prs: fetchedAt === null ? null : { prs, fetchedAt, stale },
  });
  out(
    [
      ...(failed
        ? [
            `**No PR table: gh failed (${failed}) and there is no cache/prs.json.** Every row below reads as so far; rerun when gh answers.`,
            '',
          ]
        : []),
      ...(stale ? [staleLine(stale), ''] : []),
      ...scoreLines(s, table, flags.lane),
      ...(g.length ? ['Gaps:', ...g.map((l) => `- ${l}`)] : ['Gaps: none.']),
    ].join('\n'),
  );
  return failed ? 1 : 0;
}

export async function main(
  argv: string[],
  out = (s: string) => console.log(s),
  deps: { gh: GhText } = { gh: ghText },
): Promise<number> {
  const verdict = cliGuard(argv, USAGE, FLAGS, parseArgs);
  if (verdict) {
    out(verdict.out);
    return verdict.code;
  }
  const { positional, flags } = parseArgs(argv);
  const e = env();
  switch (positional[0]) {
    case 'scan': {
      const rate = Number(flags.rate ?? 40);
      if (!(rate > 0 && rate <= MAX_RATE)) {
        out(`--rate must be in (0, ${MAX_RATE}] MB/s`);
        return 2;
      }
      const t0 = Date.now();
      const r = await scan({
        root: e.projects,
        cache: e.cache,
        maxBps: rate * 1e6,
        memoryOk: () => (anonBytes(e.cgroup) ?? 0) < ANON_LIMIT,
        log: out,
      });
      out(
        `scan: ${r.scanned}/${r.files} files read, ${(r.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.calls} calls in those files, ${r.skippedLines} oversize lines skipped`,
      );
      return 0;
    }
    case 'report': {
      const sinceDay = flags.since ?? DEFAULT_SINCE;
      const since = ptMidnight(sinceDay);
      if (!Number.isFinite(since)) {
        out('--since takes YYYY-MM-DD');
        return 2;
      }
      if (!flags['no-scan']) await scanQuiet(e, out);
      const now = Date.now();
      const { prs, note, stale, fetchedAt } = await mergedPRs(e.cache, {
        since: sinceDay,
        refresh: !!flags.refresh,
        now,
        gh: deps.gh,
      });
      const m = reportModel({
        rows: readMeter(e.usageDir).rows,
        manual: readManual(e.usageDir),
        loaded: loadCache(e.cache),
        prs,
        reports: readReports(e.archive),
        events: readEvents(e.board),
        since,
        hub: hubName(),
        now,
        phaseLog: readPhaseLog(e.usageDir),
        priors: readPriors(e.usageDir),
        ledger: readLedger(e.usageDir),
        prsFetchedAt: fetchedAt,
        stale,
      });
      const text = [
        ...(stale ? [staleLine(stale), ''] : []),
        ...(note ? [`> ${note}`, ''] : []),
        ...reportLines(m, now),
      ].join('\n');
      const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const path = join(e.usageDir, `report-${day}.md`);
      writeAtomic(path, `${text}\n`);
      out(text);
      out(`\nwritten: ${path}`);
      return 0;
    }
    case 'fit':
    case 'line': {
      if (!flags['no-scan']) await scanQuiet(e, positional[0] === 'line' ? () => {} : out);
      const m = fitModel({
        rows: readMeter(e.usageDir).rows,
        manual: readManual(e.usageDir),
        calls: loadCache(e.cache).calls,
        now: Date.now(),
      });
      out(positional[0] === 'line' ? boardLine(m) : fitLines(m).join('\n'));
      return 0;
    }
    case 'burn': {
      let at: number | null = null;
      if (flags.at !== undefined) {
        try {
          at = stopAt(flags.at, Date.now()) * 1000; // the next such local time
        } catch {
          out(`--at takes HH:MM (24 h), got ${JSON.stringify(flags.at)}`);
          return 2;
        }
      }
      if (!flags['no-scan']) await scanQuiet(e, () => {});
      const now = Date.now();
      const m = fitModel({
        rows: readMeter(e.usageDir).rows,
        manual: readManual(e.usageDir),
        calls: loadCache(e.cache).calls,
        now,
      });
      out(burnLines(m, at, now).join('\n'));
      return 0;
    }
    case 'estimate': {
      const lines = Number(flags.lines);
      if (!flags.lines || !Number.isInteger(lines) || lines < 1) {
        out('--lines takes a whole number of diff lines (source, tests and docs together)');
        return 2;
      }
      const fanout = Number(flags.fanout ?? 0);
      if (!Number.isInteger(fanout) || fanout < 0) {
        out('--fanout takes a whole number of agents');
        return 2;
      }
      const ui = !!flags.ui;
      const lenses = lensTypes(flags.lenses, ui);
      if (!lenses) {
        out(`--lenses takes a comma list of ${Object.keys(LENSES).join(', ')}`);
        return 2;
      }
      const rec = flags.lane === undefined ? null : laneArg(flags.lane, e.board, true);
      if (rec && 'error' in rec) {
        out(rec.error);
        return 2;
      }
      if (flags.scan) await scanQuiet(e, out);
      const now = Date.now();
      const cached = cachedPRs(e.cache);
      const loaded = loadCache(e.cache);
      const a = attribute(loaded, hubName(), readPhaseLog(e.usageDir));
      const prs = cached?.prs ?? [];
      const rows = prTable(a, prs, ptMidnight(DEFAULT_SINCE));
      const pr = readPriors(e.usageDir);
      const fit = fitModel({
        rows: readMeter(e.usageDir).rows,
        manual: readManual(e.usageDir),
        calls: loaded.calls,
        now,
      });
      const { units, band, k } = estimateBasis(rows, fit, pr.priors);
      const inp = { lines, ui, lenses, fanout };
      const est = predict(units, inp, band, k);
      out(
        estimateLines({
          inp,
          e: est,
          units,
          band,
          k,
          hubPerPR: rows.length ? overhead(a, rows, prs).perPR : null,
          cache: loaded.calls.length ? { prs: prs.length, to: loaded.calls.at(-1)!.ts } : null,
          priorsNote: pr.note,
        }).join('\n'),
      );
      if (!rec) return 0;
      const row: EstRow = {
        v: 1,
        lane: rec.lane,
        at: now,
        phase: rec.phase,
        inp,
        qu: est.qu,
        lo: est.quRange.lo,
        hi: est.quRange.hi,
        pct: est.pct,
        pctLo: est.pctRange.lo,
        pctHi: est.pctRange.hi,
        basis: {
          regime: units.regime,
          band: band.basis,
          k: k.basis,
          priors: pr.fromFile ? 'file' : 'placeholders',
        },
      };
      let path: string;
      try {
        path = appendLedger(e.usageDir, row);
      } catch (err) {
        out(`NOT RECORDED: ${(err as Error).message}`);
        return 1;
      }
      const cycle = current(readLedger(e.usageDir).rows, prs).find(
        (x) => x.lane === rec.lane && !x.pr,
      );
      out(
        `recorded: ${path} (lane ${rec.lane}, estimate ${(cycle?.reestimates ?? 0) + 1} this cycle${row.phase && row.phase !== 'plan' ? `, late: phase ${row.phase}` : ''})`,
      );
      return 0;
    }
    case 'score':
      return score(flags, e, out, deps);
    case 'doctor': {
      const settings = readOr(join(e.claudeDir, 'settings.json'));
      const script = statuslineScript(settings, homedir());
      const checks = doctor({
        settings,
        statusline: script ? readOr(script) : null,
        newestRowTs: newestRowTs(e.usageDir),
        now: Date.now(),
      });
      out(formatDoctor(checks));
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    default:
      out(`unknown command "${positional[0] ?? ''}"\n${USAGE}`);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = await main(process.argv.slice(2));
