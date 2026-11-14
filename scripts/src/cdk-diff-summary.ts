// @aperture/scripts — runs a stage's `cdk diff` and prints, per stack, changed or unchanged plus the header of each
// changed resource (type, path, logical id, impact: all in the public source), never a property value, the IAM table or
// an output. The whole diff goes to a file in the job's RUNNER_TEMP, which nothing uploads and which goes with the runner:
// public run logs never print it (INFRA §9 → Public repo).
//
// Run: `node scripts/src/cdk-diff-summary.ts <stage>`, after `cdk synth` wrote cdk/cdk.out. Like mask-function-url.ts:
// erasable syntax and node: builtins only, so the runner's Node strips the types with no build.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export type Result = { status: number | null; stdout: string; stderr: string };
export type Verdict = 'changed' | 'unchanged';
// `withheld`: resource headers this can't rebuild (a type or name outside the patterns below), counted, never printed.
export type Stack = { verdict: Verdict; resources: string[]; withheld: number };
type Log = (line: string) => void;

export const stacksOf = (stage: string) => [`ApertureData-${stage}`, `ApertureApp-${stage}`];

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `[~] AWS::Lambda::Function Bff Bff4A420414 replace`: prefix, type, then the construct path and logical id, then the
// impact. Rebuilt from those fields, never echoed: a name outside the code-identifier charset is left out.
const RESOURCE = /^\[([+~\-\u2190])\] ((?:AWS|Custom)::[A-Za-z0-9]+(?:::[A-Za-z0-9]+)*) (.+)$/;
const ANY_RESOURCE = /^\[[^\]]{1,2}\] [A-Za-z0-9]+::/; // a typed header; Parameter, Output etc. carry no `::`
const IMPACT = / (may be replaced|replace|destroy|orphan|import)$/;
const NAME = /^[A-Za-z0-9/_.-]+(?: [A-Za-z0-9]+)?$/;
export function resourceLine(line: string): string | undefined {
  const m = RESOURCE.exec(line);
  if (!m) return undefined;
  const impact = IMPACT.exec(m[3]!)?.[1];
  const name = impact ? m[3]!.slice(0, -impact.length - 1) : m[3]!;
  return [`[${m[1]}]`, m[2], NAME.test(name) ? name : undefined, impact && `(${impact})`]
    .filter(Boolean)
    .join(' ');
}

// CDK (2.1135) opens each stack's section with `Stack <name>`, prints `There were no differences` (plus an optional
// hint) for one with none, and closes with `Number of stacks with differences: N`. Any other shape → undefined, never a
// guess: each header exactly once, the summary exactly once, and its N equal to the sections that changed.
export function summarize(output: string, stacks: string[]): Record<string, Stack> | undefined {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  const heads = stacks.map((s) => {
    const re = new RegExp(`^Stack ${escape(s)}(?: \\(.*\\))?$`);
    return lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  });
  const counts = lines.flatMap((l) => {
    const m = /Number of stacks with differences: (\d+)$/.exec(l);
    return m ? [Number(m[1])] : [];
  });
  if (heads.some((h) => h.length !== 1) || counts.length !== 1) return undefined;
  const starts = heads.map((h) => h[0]!);
  const ends = starts.map((s) => Math.min(...[...starts, lines.length].filter((x) => x > s)));
  const sections = stacks.map((_, i) => lines.slice(starts[i]! + 1, ends[i]));
  const verdicts = sections.map((sec): Stack => ({
    verdict: sec.some((l) => l.startsWith('There were no differences')) ? 'unchanged' : 'changed',
    resources: sec.flatMap((l) => resourceLine(l) ?? []),
    withheld: sec.filter((l) => ANY_RESOURCE.test(l) && !resourceLine(l)).length,
  }));
  if (verdicts.filter((v) => v.verdict === 'changed').length !== counts[0]) return undefined;
  return Object.fromEntries(stacks.map((s, i) => [s, verdicts[i]!]));
}

// Prints a fixed error, a fixed warning or the per-stack lines — never a line of the diff as is. Returns the exit code.
export function run(
  argv: string[],
  deps: {
    diff: (stacks: string[]) => Result;
    save: (stage: string, text: string) => void;
    log: Log;
  },
): number {
  const [stage] = argv;
  if (argv.length !== 1 || !stage || !/^[a-z]+$/.test(stage))
    throw new Error('usage: cdk-diff-summary.ts <stage>');
  const stacks = stacksOf(stage);
  const r = deps.diff(stacks);
  deps.save(stage, `${r.stdout}\n${r.stderr}`);
  // A failing diff fails the job, as when it printed: its output may be the diff, so it stays off the log.
  if (r.status !== 0) {
    deps.log(
      `::error::cdk diff failed (exit ${r.status ?? 'none'}); its output stays off the public log (INFRA §9 → Public repo)`,
    );
    return 1;
  }
  const verdicts = summarize(`${r.stdout}\n${r.stderr}`, stacks);
  // An informational step never blocks a deploy: an output this can't read (a CDK upgrade?) reads unknown.
  if (!verdicts)
    deps.log(
      "::warning::couldn't read cdk diff's output (a CDK upgrade?) — fix scripts/src/cdk-diff-summary.ts",
    );
  for (const s of stacks) {
    deps.log(`${s}: ${verdicts?.[s]?.verdict ?? 'unknown'}`);
    for (const r of verdicts?.[s]?.resources ?? []) deps.log(`  ${r}`);
    if (verdicts?.[s]?.withheld)
      deps.log(`  (${verdicts[s].withheld} more resource header(s) withheld)`);
  }
  return 0;
}

if (process.argv[1]?.endsWith('cdk-diff-summary.ts')) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  process.exitCode = run(process.argv.slice(2), {
    // Both streams captured, never inherited, whichever one CDK writes to; no --fail, so a non-zero exit is an error.
    diff: (stacks) => {
      const r = spawnSync(
        'pnpm',
        [
          '--filter',
          '@aperture/cdk',
          'exec',
          'cdk',
          'diff',
          '--app',
          'cdk.out',
          ...stacks,
          '--method=template',
        ],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 },
      );
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    save: (stage, text) =>
      writeFileSync(`${process.env.RUNNER_TEMP ?? tmpdir()}/aperture-cdk-diff.${stage}.txt`, text),
    log: (l) => console.log(l),
  });
}
