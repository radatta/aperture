// PACKAGES[].projects against vitest itself: per package, `vitest list --filesOnly` (globs only, runs no test) must
// find exactly the files, project for project, that the registry check's static globs select from the same tree. So
// the ~1–2 s pre-check (registry.ts) can't drift from what the suite runs. Its rule runs it on any vitest config change.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { projectsFor, TEST_NAMED } from './registry.ts';
import { PACKAGES } from './rules.ts';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// As the gate lists them: on disk (a deleted-but-indexed path is listed), once (an unmerged path is listed per stage).
const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    cwd: ROOT,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((f) => f && existsSync(join(ROOT, f)));
const files = [...new Set(listed)];

// The spawned vitest must not think it runs inside this one, nor inherit this run's worker tuning.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith('VITEST') && k !== 'NODE_ENV' && k !== 'TEST',
  ),
);
const out = mkdtempSync(join(tmpdir(), 'gate-includes-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const vitestList = async (dir: string) => {
  const json = join(out, `${dir.replace('/', '-')}.json`);
  await promisify(execFile)(
    join(ROOT, dir, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', `--json=${json}`],
    { cwd: join(ROOT, dir), env, timeout: 60_000, killSignal: 'SIGKILL' }, // never a stray vitest past the test
  );
  const rows = JSON.parse(readFileSync(json, 'utf8')) as { file: string; projectName?: string }[];
  return rows.map((r) => `${r.projectName || '-'} ${relative(ROOT, r.file)}`).sort();
};

const staticList = (dir: string) => {
  const pkg = PACKAGES.find((p) => p.dir === dir)!;
  return files
    .filter((f) => f.startsWith(`${dir}/`) && TEST_NAMED.test(f))
    .flatMap((f) =>
      projectsFor(pkg.projects, f.slice(dir.length + 1)).map((p) => `${p.name ?? '-'} ${f}`),
    )
    .sort();
};

describe('PACKAGES[].projects', () => {
  it('select what vitest itself runs, project for project, in every package', async () => {
    const found = await Promise.all(PACKAGES.map((p) => vitestList(p.dir)));
    PACKAGES.forEach((p, i) => {
      expect(found[i]!.length, p.dir).toBeGreaterThan(0);
      expect(staticList(p.dir), p.dir).toEqual(found[i]);
    });
  }, 90_000);
});
