// @aperture/scripts — a rules.ts change can't narrow its own gate: the diff is planned with HEAD's rules and with the
// merge-base's, and the union runs (docs/ops/GATE.md → The rules). The base copy is loaded on its own from a temp
// `.mts` (rules.ts imports nothing; rules.test.ts pins it). Anything that stops a fair comparison — the base copy
// unreadable or not loadable, rules.ts added or deleted, the package list changed — runs the whole suite instead.
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { plan, type Change, type Plan, type Rules } from './plan.ts';
import * as HEAD_RULES from './rules.ts';

export const RULES_PATH = 'scripts/src/gate/rules.ts';

const ARRAYS = ['PACKAGES', 'REPO_FULL', 'PACKAGE_FULL', 'INPUT_RULES', 'ALWAYS_RUN'] as const;
// An import, static or dynamic, or a re-export: the copy is loaded alone, so it must stand alone.
const IMPORTS = /^\s*import[\s{*'"]|^\s*export\s[^;]*\bfrom\s*['"]|\bimport\s*\(/m;

// rules.ts text → its data. Throws on an import, a failed load or a missing export.
export async function loadRules(text: string): Promise<Rules> {
  if (IMPORTS.test(text)) throw new Error('it imports a module, so it can’t load alone');
  const dir = mkdtempSync(join(tmpdir(), 'gate-base-'));
  try {
    const file = join(dir, 'rules.mts');
    writeFileSync(file, text);
    const m = (await import(pathToFileURL(file).href)) as Partial<Rules>;
    for (const k of ARRAYS) if (!Array.isArray(m[k])) throw new Error(`no ${k} array`);
    if (typeof m.MAX_CHANGED !== 'number') throw new Error('no MAX_CHANGED number');
    if (!(m.MODULE_EXT instanceof RegExp)) throw new Error('no MODULE_EXT RegExp');
    return m as Rules;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const merge = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.includes(x))];

// Everything either plan runs. A test only the base named keeps the base's reason, marked.
export function union(a: Plan, b: Plan): Plan {
  const packages: Plan['packages'] = {};
  for (const dir of Object.keys(a.packages)) {
    const x = a.packages[dir]!;
    const y = b.packages[dir] ?? { full: [], related: [], tests: [], why: {} };
    const why = { ...x.why };
    for (const t of y.tests) why[t] ??= `${y.why[t]} (the merge-base rules)`;
    packages[dir] = {
      full: merge(
        x.full,
        y.full.map((w) => `${w} (the merge-base rules)`),
      ),
      related: merge(x.related, y.related),
      tests: merge(x.tests, y.tests),
      why,
    };
  }
  return {
    full: merge(
      a.full,
      b.full.map((w) => `${w} (the merge-base rules)`),
    ),
    packages,
    notes: merge(a.notes, b.notes),
  };
}

// `readBase` returns the merge-base's rules.ts text, or throws (git show failed, the file isn't there).
export async function planWithBase(
  changes: Change[],
  testFiles: string[],
  readBase: () => string,
  load: (text: string) => Promise<Rules> = loadRules,
): Promise<Plan> {
  const head = plan(changes, testFiles);
  const c = changes.find((x) => x.path === RULES_PATH);
  if (!c) return head;
  const full = (why: string) => ({ ...head, full: [...head.full, `${RULES_PATH}: ${why}`] });
  if (c.deleted) return full('deleted, so there are no rules to judge it by');
  let base: Rules;
  try {
    base = await load(readBase());
  } catch (err) {
    const why = (err as Error).message.split('\n')[0];
    return full(`the merge-base's copy couldn't be loaded (${why}), so it can’t be compared`);
  }
  if (JSON.stringify(base.PACKAGES) !== JSON.stringify(HEAD_RULES.PACKAGES))
    return full('the package list changed, so the two plans don’t compare');
  const out = union(head, plan(changes, testFiles, base));
  out.notes.push(`${RULES_PATH} changed: planned with the merge-base's rules too; the union runs`);
  return out;
}
