// `pnpm usage <command>`: the usage cost model (docs/ops/USAGE-METER.md). Data lives in the gitignored usage dir;
// nothing here writes a tracked file. Plain `node` (Node 22 strips types): erasable syntax, node: builtins only.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliGuard } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { parseMeter, type Manual, type MeterRow } from './meter.ts';
import { fitModel } from './model.ts';
import { boardLine, fitLines } from './report.ts';
import { anonBytes, scan } from './scan.ts';
import { loadCache } from './store.ts';

export const USAGE = `pnpm usage <command>   (-h / --help on any command: its usage; nothing runs)
  scan [--rate <MB/s>]          read new transcript bytes into the cache (rate-limited, resumable)
  fit [--no-scan]               k (meter % per QU) with its interval, the holdout, burn now
  line [--no-scan]              one line: usage % · %/h · hours to 100
  doctor                        is the meter logger installed and writing?`;

export const FLAGS: Record<string, Spec> = {
  scan: { flags: ['rate'] },
  fit: { bare: ['no-scan'] },
  line: { bare: ['no-scan'] },
  doctor: {},
};

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = 'true';
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
  };
};

const MAX_RATE = 60; // MB/s: the ceiling the COI read detector leaves (docs/ops/USAGE-METER.md → Scan)
const ANON_LIMIT = 10 * 1024 ** 3;
const readOr = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

export function newestRowTs(usageDir: string): string | null {
  const days = existsSync(usageDir)
    ? readdirSync(usageDir).filter((f) => /^meter-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    : [];
  const last = days.at(-1);
  if (!last) return null;
  const rows = readFileSync(join(usageDir, last), 'utf8').trimEnd().split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(rows[i]).ts ?? null;
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
    ? readdirSync(usageDir).filter((f) => /^meter-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    : [];
  const all = parseMeter(files.map((f) => readFileSync(join(usageDir, f), 'utf8')).join('\n'));
  return all;
}

export function readManual(usageDir: string): Manual | null {
  try {
    const m = JSON.parse(readFileSync(join(usageDir, 'manual-readings.json'), 'utf8'));
    return { readings: m.readings ?? [], resets: m.resets ?? [] };
  } catch {
    return null;
  }
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

export async function main(argv: string[], out = (s: string) => console.log(s)): Promise<number> {
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

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
