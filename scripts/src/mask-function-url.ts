// @aperture/scripts — keeps the Lambda Function URLs out of public run logs (INFRA §9 → Public repo). The URLs skip
// CloudFront; the origin secret still gates them, so this is defence in depth, not a secret. `cdk deploy` prints every
// stack output, so the deploy job registers a `::add-mask::` for each Function URL before any step prints one.
// A mask covers only its own job's later lines, which is why deploy-stage.yml runs this twice: from CloudFormation
// before synth, and from the outputs file after `Deploy stacks` (a URL that deploy created). A URL new in this deploy
// still prints once, in that deploy's own Outputs block — a documented gap.
//
// Run: `node scripts/src/mask-function-url.ts <stage> [--from-file]`. Like classify-changes.ts: erasable syntax and
// node: builtins only, so the runner's Node strips the types with no build.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Outputs = Record<string, Record<string, string>>; // stack → { OutputKey: OutputValue }
export type Describe = (stack: string) => string; // the aws CLI's JSON; throws with .stderr
type Log = (line: string) => void;

const URL_HOST = /^[a-z0-9]{16,}\.lambda-url\.[a-z0-9-]+\.on\.aws$/;
const hostOf = (v: string) =>
  v
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();

// The host covers every printed form (with or without scheme, slash or path); its first label, the url-id, any other.
export function masksFor(value: string): string[] {
  const host = hostOf(value);
  return URL_HOST.test(host) ? [host, host.split('.')[0]!] : [];
}

// Every output that is a Function URL, whatever its key, so a second URL output is covered without an edit here.
export const masksIn = (outputs: Outputs): string[] => [
  ...new Set(Object.values(outputs).flatMap((o) => Object.values(o).flatMap(masksFor))),
];

export const stacksOf = (stage: string) => [`ApertureData-${stage}`, `ApertureApp-${stage}`];

// A stack that doesn't exist yet (a first deploy) has nothing to mask. Any other failure throws: an unreadable stack
// must not deploy unmasked, and nothing has deployed yet when this runs.
export function fromCloudFormation(stage: string, describe: Describe, log: Log): Outputs {
  const out: Outputs = {};
  for (const stack of stacksOf(stage)) {
    try {
      const arr = (JSON.parse(describe(stack)) ?? []) as {
        OutputKey: string;
        OutputValue: string;
      }[];
      out[stack] = Object.fromEntries(arr.map((o) => [o.OutputKey, o.OutputValue]));
    } catch (err) {
      if (!/\bdoes not exist\b/.test(String((err as { stderr?: unknown }).stderr ?? ''))) throw err;
      log(`::notice::${stack} doesn't exist yet — nothing to mask`);
    }
  }
  return out;
}

// A `FunctionUrl` that isn't a lambda-url host means AWS changed the format: say so, and still mask the bare host.
export function masksWithFallback(outputs: Outputs, log: Log): string[] {
  const masks = masksIn(outputs);
  for (const o of Object.values(outputs)) {
    const v = o.FunctionUrl;
    if (v === undefined || masksFor(v).length) continue;
    log(`::warning::FunctionUrl isn't a lambda-url host — masking it as is`);
    const host = hostOf(v);
    if (host.length >= 12) masks.push(host);
  }
  return [...new Set(masks)];
}

// Only `::add-mask::` lines and a count: the value reaches the log in no other form.
export function emit(masks: string[], stage: string, log: Log): void {
  for (const m of masks) log(`::add-mask::${m}`);
  log(
    masks.length
      ? `masked ${masks.length} value(s) for ${stage}`
      : `::notice::no Function URL in ${stage}'s outputs — nothing masked`,
  );
}

export function run(
  argv: string[],
  deps: { describe: Describe; readFile: (p: string) => string; log: Log },
) {
  const [stage, flag] = argv;
  if (
    !stage ||
    !/^[a-z]+$/.test(stage) ||
    (flag !== undefined && flag !== '--from-file') ||
    argv.length > 2
  )
    throw new Error('usage: mask-function-url.ts <stage> [--from-file]');
  // --from-file reads what `cdk deploy --outputs-file` (run in cdk/) just wrote; nothing written → nothing new to mask.
  let outputs: Outputs;
  if (flag) {
    let text: string | undefined;
    try {
      text = deps.readFile(`cdk/cdk-outputs.${stage}.json`);
    } catch {
      deps.log(`::notice::no cdk-outputs.${stage}.json — nothing new to mask`);
    }
    outputs = text === undefined ? {} : (JSON.parse(text) as Outputs);
  } else outputs = fromCloudFormation(stage, deps.describe, deps.log);
  emit(masksWithFallback(outputs, deps.log), stage, deps.log);
}

if (process.argv[1]?.endsWith('mask-function-url.ts')) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  run(process.argv.slice(2), {
    // stdout captured, never inherited: the outputs reach the log only as masks.
    describe: (stack) =>
      execFileSync(
        'aws',
        [
          'cloudformation',
          'describe-stacks',
          '--stack-name',
          stack,
          '--query',
          'Stacks[0].Outputs',
          '--output',
          'json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    readFile: (p) => readFileSync(`${root}/${p}`, 'utf8'),
    log: (l) => console.log(l),
  });
}
