// No root script may share a name with a pnpm built-in: the built-in wins and the script never runs (pnpm 11.18's
// `lane` shadowed ours, F141). `pnpm help <name>` is the probe — it runs nothing, and prints `No results` for a name
// that isn't a built-in. `pnpm <name> --help` would run a non-colliding script, and the top-level `pnpm help` list
// misses `lane`, so neither works as the check.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const scripts = Object.keys(
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {},
);
const help = async (name: string) =>
  (await promisify(execFile)('pnpm', ['help', name], { cwd: ROOT })).stdout;
const isBuiltin = async (name: string) => !(await help(name)).includes(`No results for "${name}"`);
// Each probe is a full pnpm start (~0.3–2 s of CPU), so at most 4 at once.
async function builtins(names: string[]): Promise<string[]> {
  const hits: string[] = [];
  const queue = [...names];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift())
      if (await isBuiltin(n)) hits.push(n);
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return hits.sort();
}

describe('root package.json scripts', () => {
  it('the probe tells a built-in from a free name (a changed help format fails here, not silently)', async () => {
    expect(await builtins(['install', 'lane', 'no-such-command-here'])).toEqual([
      'install',
      'lane',
    ]);
  }, 60_000);

  it('no script name collides with a pnpm built-in', async () => {
    expect(scripts.length).toBeGreaterThan(0);
    expect(await builtins(scripts)).toEqual([]);
  }, 120_000);
});
