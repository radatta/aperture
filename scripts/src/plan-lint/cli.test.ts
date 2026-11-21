import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRoot, fsTree, main, USAGE } from './cli.ts';

const CLEAN = `# Plan: x

Template: light — one doc line

## Operator steps

none

## Files

| # | File | Via |
| --- | --- | --- |
| 1 | \`docs/a.md\` | commit |

## Change census

| ID | State | Writers | Readers | Searches → hits | Change |
| --- | --- | --- | --- | --- | --- |
| C1 | a phrase | \`docs/a.md:2\` | none | \`rg -n -e phrase docs\` → 1 | reworded |

## Unknowns

none

## Invariants

| ID | Invariant | Failing test |
| --- | --- | --- |
| I1 | the phrase stays | T1 |

## Test matrix

| ID | Case | Proof | Fails when |
| --- | --- | --- | --- |
| T1 | read the doc | manual | fails when: the line is deleted |

## Step plan

| # | Step | Phase key | Minutes | From |
| --- | --- | --- | --- | --- |
| 1 | edit | build | 5–10 | no history |

## Open questions

none
`;

let root: string;
const here = () => fileURLToPath(new URL('.', import.meta.url));
// a child run that isn't `pnpm plan-lint`, whatever ran vitest
const noInit = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'INIT_CWD' && k !== 'npm_lifecycle_event'),
);
const dirs: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};
let out: string[];
const log = (s: string) => void out.push(s);
beforeEach(() => {
  root = temp('plan-lint-');
  writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n'); // a worktree's .git is a file
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'localNotes'));
  writeFileSync(join(root, 'docs/a.md'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'localNotes/plan.md'), CLEAN);
  out = [];
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('plan-lint cli', () => {
  it('--help prints usage, exit 0, and reads nothing', () => {
    expect(main(['--help', '/nonexistent'], log, '/nonexistent')).toBe(0);
    expect(out).toEqual([USAGE]);
  });

  it('a clean plan: exit 0 and only the summary', () => {
    expect(main([], log, join(root, 'docs'))).toBe(0);
    expect(out).toEqual(['plan-lint: 0 problems (light)']);
  });

  it('problems: exit 1, one file:line: check: message line each, sorted, then the summary', () => {
    const bad = CLEAN.replace('`docs/a.md:2`', '`docs/a.md:9`')

      .replace(
        '| 1 | edit | build | 5–10 | no history |',
        '| 1 | edit | build | soon | no history |',
      );
    writeFileSync(join(root, 'p.md'), bad);
    expect(main(['p.md'], log, root)).toBe(1);
    expect(out).toEqual([
      'p.md:19: path: `docs/a.md:9`: docs/a.md has 3 lines',
      'p.md:41: steps: no `<lo>–<hi>` minutes',
      'plan-lint: 2 problems (light)',
    ]);
  });

  it('--root resolves paths against another tree', () => {
    const other = temp('plan-lint-other-');
    mkdirSync(join(other, 'docs'));
    writeFileSync(join(other, 'docs/a.md'), 'only one line\n');
    expect(main([join(root, 'localNotes/plan.md'), '--root', other], log, root)).toBe(1);
    expect(out[0]).toMatch(/path: `docs\/a.md:2`: docs\/a.md has 1 lines$/);
  });

  it('exit 2: unknown flag, extra argument, --root without a dir, unreadable file, no root', () => {
    expect(main(['--strict'], log, root)).toBe(2);
    expect(main(['a.md', 'b.md'], log, root)).toBe(2);
    expect(main(['--root'], log, root)).toBe(2);
    expect(main(['missing.md'], log, root)).toBe(2);
    expect(out.at(-1)).toMatch(/^plan-lint — can't read .*missing\.md/);
    // no checkout above it: holds wherever the temp dir is outside one (CI, the Mac, the container)
    const loose = temp('plan-lint-loose-');
    if (findRoot(tmpdir()) === undefined) {
      expect(findRoot(loose)).toBeUndefined();
      expect(main([], log, loose)).toBe(2);
    }
  });

  it('findRoot walks up to the nearest .git; fsTree counts lines and lists the top level', () => {
    expect(findRoot(join(root, 'docs'))).toBe(root);
    const t = fsTree(root);
    expect([...t.topLevel].sort()).toEqual(['.git', 'docs', 'localNotes']);
    expect(t.lineCount('docs/a.md')).toBe(3);
    expect(t.lineCount('docs')).toBeUndefined();
    expect(t.lineCount('docs/none.md')).toBeUndefined();
    expect(t.exists('docs/a.md')).toBe(true);
    expect(t.exists('./docs/a.md')).toBe(true);
    expect(t.exists('docs/')).toBe(true);
    // exact case even on a case-insensitive file system, and never outside the root
    expect(t.exists('docs/A.md')).toBe(false);
    expect(t.exists('Docs/a.md')).toBe(false);
    expect(t.exists('docs/../docs/a.md')).toBe(false);
  });

  it('under pnpm plan-lint, a relative file is relative to where it was typed', () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub/q.md'), CLEAN);
    const env = { ...noInit, npm_lifecycle_event: 'plan-lint', INIT_CWD: join(root, 'sub') };
    const out = execFileSync(process.execPath, [join(here(), 'cli.ts'), 'q.md', '--root', '..'], {
      cwd: root,
      env,
    }).toString();
    expect(out).toContain('plan-lint: 0 problems (light)');
  });

  it('runs as a script, and never spawns or runs what a plan names', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    for (const f of ['cli.ts', 'lint.ts'])
      expect(readFileSync(join(here, f), 'utf8')).not.toMatch(
        /['"](node:)?child_process['"]|(?<![.\w])(spawn|exec|execFile)(Sync)?\(/,
      );
    // a census command that would create a file, if anything ran it
    const marker = join(root, 'ran-marker');
    writeFileSync(
      join(root, 'p.md'),
      CLEAN.replace('`rg -n -e phrase docs`', `\`rg -n -e phrase docs; touch ${marker}\``),
    );
    let code = 0;
    try {
      execFileSync(process.execPath, [join(here, 'cli.ts'), 'p.md'], {
        cwd: root,
        stdio: 'pipe',
        env: noInit,
      });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    expect(code).toBe(1); // the chained command is a census problem, and nothing ran
    expect(() => readFileSync(marker)).toThrow();
    const help = execFileSync(process.execPath, [join(here, 'cli.ts'), '--help'], {
      cwd: root,
    }).toString();
    expect(help.trim()).toBe(USAGE);
  });
});
