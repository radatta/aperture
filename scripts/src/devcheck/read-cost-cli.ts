// @aperture/scripts — `pnpm devcheck:cost` (docs/ops/DEV-CHECK.md → Read cost): a dev run's read units and Lambda ms,
// per phase, scenario, step, op and access, from its report.json and the `pnpm bot logs` fetches of its window.
// Reads files only; never fetches, spawns or writes outside --out. Plain `node`: erasable syntax, node: builtins only.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyse, checkCap, parseLogs, render } from './read-cost.ts';
import type { Analysis } from './read-cost.ts';
import type { RunResult } from './report.ts';

export const USAGE = `pnpm devcheck:cost --report <report.json> --logs <devlogs dir> [--logs <dir>…] [--before <analysis.json>] [--out <file.md>]
  joins the dev slots' ddb_units lines and Lambda REPORT lines (pnpm bot logs --filter '%ddb_units%', then --filter
  REPORT, over the run's window) to the run's step windows and prints the read-cost tables.
  --report   the run's localNotes/devcheck/<run>/report.json
  --logs     a localNotes/devlogs/<key> directory (every *.log in it); repeat for the units and the REPORT fetches
  --before   an earlier run's analysis JSON (written beside --out) for before/after columns
  --out      write the markdown here and the analysis JSON beside it (<out>.json); default: markdown to stdout
  Exit: 0 tables written · 1 refused (a fetch at its cap, a report without step stamps, a parallel two-lane run) · 2 a bad argument`;

interface Args {
  report?: string;
  logs: string[];
  before?: string;
  out?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { logs: [], help: false };
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
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.help && (!a.report || !a.logs.length)) throw new Error('--report and --logs are required');
  return a;
}

export function run(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
): number {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    out(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (a.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  try {
    const texts: string[] = [];
    for (const dir of a.logs)
      for (const f of readdirSync(dir)
        .filter((x) => x.endsWith('.log'))
        .sort()) {
        const text = readFileSync(join(dir, f), 'utf8');
        checkCap(join(dir, f), text);
        texts.push(text);
      }
    const report = JSON.parse(readFileSync(a.report!, 'utf8')) as RunResult;
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
    out(`devcheck:cost: ${(e as Error).message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = run(process.argv.slice(2));
