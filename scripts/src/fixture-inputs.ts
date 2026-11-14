// @aperture/scripts — should a PR's CI run the mailroom fixture suite? Given the PR's changed paths, true when
// any of them is an input of scripts/src/mailroom/runner-fixtures.test.ts, the ~210 s+ bulk of CI's non-app
// step. A main push never asks: it always runs the suite (.github/workflows/ci.yml).
//
// The suite reads only tools/mailroom/ (the runner, its jobs, the fixtures, testdata) and identifiers.json,
// and imports only from scripts/src/mailroom/ and scripts/src/identifiers.ts at runtime; fixture-inputs.test.ts
// walks those imports so the list can't fall behind.
// What it can't see — a runner-image, Node or dependency bump that breaks the suite without touching these
// paths — surfaces on the main push instead, where `check` gates the deploy (INFRA §9).
//
// Run: `node scripts/src/fixture-inputs.ts` (what CI does, like classify-changes.ts: the runner's Node strips
// types natively, so erasable syntax and node: builtins only). Reads newline-separated paths on stdin, prints
// `true`/`false` on stdout and why on stderr — a skip is a ::notice:: on the run, never silent.
import { readFileSync } from 'node:fs';

export const FIXTURE_SUITE = 'scripts/src/mailroom/runner-fixtures.test.ts';

// A trailing slash is a directory prefix; anything else is an exact path.
export const FIXTURE_INPUTS = [
  'tools/mailroom/',
  'scripts/src/mailroom/',
  'scripts/vitest.config.ts', // how the suite is found and run
  'scripts/package.json', // the vitest pin and the test script
  'scripts/tsconfig.json',
  'scripts/src/fixture-inputs.ts', // this rule: changing it runs the suite
  'scripts/src/identifiers.ts', // the sim pins' expected values (docs/ops/IDENTIFIERS.md)
  'identifiers.json',
  '.github/workflows/ci.yml', // the gate itself, so a CI change proves the suite still runs
  '.github/actions/', // the runner's toolchain setup
];

const isInput = (path: string) =>
  FIXTURE_INPUTS.some((i) => (i.endsWith('/') ? path.startsWith(i) : path === i));

// An empty changeset runs it: an empty diff is a broken diff, and a wrong skip hides a break where a wrong
// run only costs minutes.
export function touchesFixtureInputs(files: string[]): { run: boolean; hits: string[] } {
  const paths = files.map((f) => f.trim()).filter(Boolean);
  if (!paths.length) return { run: true, hits: [] };
  const hits = paths.filter(isInput);
  return { run: hits.length > 0, hits };
}

if (process.argv[1]?.endsWith('fixture-inputs.ts')) {
  const { run, hits } = touchesFixtureInputs(readFileSync(0, 'utf8').split('\n'));
  process.stderr.write(
    run
      ? `${FIXTURE_SUITE}: runs — ${hits.length ? `changed: ${hits.join(' ')}` : 'no diff to judge'}\n`
      : `::notice::${FIXTURE_SUITE} skipped on this PR — none of its inputs changed (${FIXTURE_INPUTS.join(' ')}); every main push runs it\n`,
  );
  process.stdout.write(String(run));
}
