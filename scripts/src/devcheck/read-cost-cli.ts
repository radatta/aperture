// @aperture/scripts — `pnpm devcheck:cost` (docs/ops/DEV-CHECK.md → Read cost): a dev run's read units and Lambda ms,
// per phase, scenario, step, op and access, from its report.json and the `pnpm bot logs` fetches of its window.
// Reads files only; never fetches, spawns or writes outside --out. Plain `node`: erasable syntax, node: builtins only.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  analyse,
  checkCap,
  fetchLines,
  oneUser,
  parseLogs,
  render,
  slotGroups,
} from './read-cost.ts';
import type { Analysis } from './read-cost.ts';
import type { RunResult } from './report.ts';

export const USAGE = `pnpm devcheck:cost --report <report.json> --logs <devlogs dir> [--logs <dir>…] [--before <analysis.json>] [--out <file.md>]
pnpm devcheck:cost --report <report.json> --window
  joins the dev slots' ddb_units lines and Lambda REPORT lines (pnpm bot logs --filter '%ddb_units%', then --filter
  REPORT, over the run's window) to the run's step windows and prints the read-cost tables.
  --report   the run's localNotes/devcheck/<run>/report.json
  --logs     a localNotes/devlogs/<key> directory (every *.log in it); repeat for the units and the REPORT fetches
  --before   an earlier run's analysis JSON (written beside --out) for before/after columns
  --out      write the markdown here and the analysis JSON beside it (<out>.json); default: markdown to stdout
  --window   print the two \`pnpm bot logs\` fetches for the run's window and slot, and stop
  Exit: 0 written · 1 refused (a fetch at its cap, failed, missing a group or holding the other slot's; no units
  line in the run across the fetches; a report
  without step stamps; a two-user run) · 2 a bad argument`;

interface Args {
  report?: string;
  logs: string[];
  before?: string;
  out?: string;
  window: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { logs: [], window: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined || x.startsWith('--')) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--report') a.report = v();
    else if (k === '--logs') a.logs.push(v());
    else if (k === '--before') a.before = v();
    else if (k === '--out') a.out = v();
    else if (k === '--window') a.window = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.help) return a;
  if (!a.report) throw new Error('--report is required');
  if (a.window && (a.logs.length || a.before || a.out))
    throw new Error('--window takes only --report');
  if (!a.window && !a.logs.length) throw new Error('--logs is required');
  return a;
}

// Each --logs directory: exactly the run's slot's two edge groups (a partial artifact lacks one; the other slot's
// would put its own run's units in this run's windows). Other groups' files are left unread.
const EDGE_GROUPS = (['dev', 'devb'] as const).flatMap((s) =>
  slotGroups({ target: s } as RunResult),
);
function readLogs(dir: string, groups: string[]): string[] {
  const all = readdirSync(dir).filter((x) => x.endsWith('.log'));
  if (!all.length)
    throw new Error(`${dir}: no .log file — not a \`pnpm bot logs\` fetch directory`);
  const other = all.find(
    (f) => EDGE_GROUPS.includes(f.slice(0, -4)) && !groups.includes(f.slice(0, -4)),
  );
  if (other)
    throw new Error(
      `${dir}: ${other} is the other slot's group — this run's are ${groups.join(', ')}`,
    );
  for (const g of groups)
    if (!all.includes(`${g}.log`))
      throw new Error(`${dir}: no ${g} group's log — a partial fetch; refetch both groups`);
  return groups
    .map((g) => `${g}.log`)
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      checkCap(join(dir, f), text);
      return text;
    });
}

export function run(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): number {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (a.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  try {
    const report = JSON.parse(readFileSync(a.report!, 'utf8')) as RunResult;
    if (a.window) {
      oneUser(report);
      out(`${fetchLines(report).join('\n')}\n`);
      return 0;
    }
    const texts = a.logs.flatMap((d) => readLogs(d, slotGroups(report)));
    const analysis = analyse(report, parseLogs(texts));
    const before = a.before ? (JSON.parse(readFileSync(a.before, 'utf8')) as Analysis) : undefined;
    const md = render(analysis, before);
    if (a.out) {
      writeFileSync(a.out, md);
      writeFileSync(`${a.out}.json`, `${JSON.stringify(analysis, null, 1)}\n`);
      out(`wrote ${a.out} and ${a.out}.json\n`);
    } else out(md);
    return 0;
  } catch (e) {
    err(`devcheck:cost: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = run(process.argv.slice(2));
