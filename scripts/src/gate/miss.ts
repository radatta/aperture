// @aperture/scripts — the miss alarm (docs/ops/GATE.md → A miss): when `gate:ci` reads a failed run, it names the
// failing test files from the run's failed logs and checks each against the plan `gate:fast` makes for that sha. A file
// the plan didn't run is a miss: printed loudly and logged as one `kind: "gate-miss"` row in the board's
// history/events-<UTC day>.jsonl. It never changes the verdict; ci.ts runs it after the verdict line, and any error in
// it is printed as such. Plain `node`: erasable syntax, node: builtins only.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionNames } from '../board/sessions.ts';
import { boardDir } from '../bot/lock-cache.ts';
import type { Run } from '../bot/sh.ts';
import { planWithBase, RULES_PATH } from './base.ts';
import type { GhRun } from './ci.ts';
import { isTest, modeOf, pkgOf, type Change, type Plan } from './plan.ts';

export interface MissEvent {
  v: 1;
  t: string;
  kind: 'gate-miss';
  name: string | null;
  branch: string;
  sha: string;
  run: number;
  workflow: string;
  url: string;
  failing: string[];
  missed: { file: string; why: string }[];
  unsure: { file: string; why: string }[];
}

const ANSI = /\x1b\[[0-9;]*m/g;
// `<job>\t<step>\t<ts> [<pkg dir> test: ] FAIL [|project| ]<path> [> test name | [ path ]]`
const FAIL = /^([^\t]*)\t[^\t]*\t\S+\s+(?:(\S+) test: )?\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+)/;

// The failed logs → the failing test files, as repo paths. A line's package comes from pnpm's `<dir> test:` prefix,
// an app shard's job name, or a unique match among the sha's test files.
export function failingFiles(log: string, testFiles: string[]): string[] {
  const out = new Set<string>();
  for (const raw of log.split('\n')) {
    const m = FAIL.exec(raw.replace(ANSI, ''));
    if (!m || !isTest(m[3]!)) continue;
    const [, job, dir, path] = m as unknown as [string, string, string | undefined, string];
    const pkg = dir ?? (/test-app/.test(job) ? 'app' : undefined);
    if (pkg) out.add(`${pkg}/${path}`);
    else {
      const hits = testFiles.filter((t) => t === path || t.endsWith(`/${path}`));
      out.add(hits.length === 1 ? hits[0]! : path);
    }
  }
  return [...out];
}

export type Deps = (pkgDir: string, files: string[]) => Record<string, string[]>; // repo paths → their deps

export interface Judged {
  ran: string[];
  missed: { file: string; why: string }[];
  unsure: { file: string; why: string }[];
}

// Each failing file against the plan. `graph` is false when the tree here isn't the run's (another HEAD, or edits):
// a fast package's un-named file can then only be unsure.
export function judge(files: string[], p: Plan, deps: Deps, graph: boolean): Judged {
  const out: Judged = { ran: [], missed: [], unsure: [] };
  const fast: Record<string, string[]> = {};
  for (const f of files) {
    const pkg = pkgOf(f);
    if (p.full.length) out.ran.push(f);
    else if (!pkg) out.unsure.push({ file: f, why: 'in no test package (rules.ts PACKAGES)' });
    else if (modeOf(p, pkg.dir) === 'full') out.ran.push(f);
    else if (modeOf(p, pkg.dir) === 'skip')
      out.missed.push({ file: f, why: `${pkg.dir} was skipped: nothing in the diff reaches it` });
    else if (p.packages[pkg.dir]!.tests.includes(f)) out.ran.push(f);
    else if (!p.packages[pkg.dir]!.related.length)
      out.missed.push({ file: f, why: `${pkg.dir} ran named tests only, not this one` });
    else (fast[pkg.dir] ??= []).push(f);
  }
  for (const [dir, fs] of Object.entries(fast)) {
    if (!graph) {
      for (const f of fs)
        out.unsure.push({
          file: f,
          why: 'the tree here isn’t the run’s, so its imports can’t be read',
        });
      continue;
    }
    let d: Record<string, string[]>;
    try {
      d = deps(dir, fs);
    } catch (err) {
      for (const f of fs)
        out.unsure.push({ file: f, why: `its imports couldn't be read (${msg(err)})` });
      continue;
    }
    const related = new Set(p.packages[dir]!.related);
    for (const f of fs)
      if (!d[f]) out.unsure.push({ file: f, why: 'vitest doesn’t collect it here' });
      else if (d[f].some((x) => related.has(x))) out.ran.push(f);
      else
        out.missed.push({
          file: f,
          why: `${dir} ran \`vitest related\`, and no changed module reaches it`,
        });
  }
  return out;
}

const msg = (err: unknown) => (err as Error).message.split('\n')[0];
const fields = (s: string) => s.split('\0').filter(Boolean);
const RELATED = fileURLToPath(new URL('./related.ts', import.meta.url));

// related.ts in a package dir, its absolute paths mapped back to repo paths.
export const vitestDeps =
  (run: Run, root: string): Deps =>
  (dir, files) => {
    const abs = (f: string) => `${root}/${f}`;
    const rel = (a: string) => (a.startsWith(`${root}/`) ? a.slice(root.length + 1) : a);
    const raw = JSON.parse(
      run(process.execPath, [RELATED, ...files.map(abs)], { cwd: abs(dir), timeoutMs: 120_000 }),
    ) as Record<string, string[]>;
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [rel(k), v.map(rel)]));
  };

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const eventsFile = (dir: string, ms: number) =>
  join(dir, 'history', `events-${new Date(ms).toISOString().slice(0, 10)}.jsonl`);

// Already logged for this run (today's or yesterday's file): a repeat `gate:ci` prints, but doesn't log again.
function logged(dir: string, run: number, nowMs: number): boolean {
  for (const ms of [nowMs - 86400_000, nowMs]) {
    let text: string;
    try {
      text = readFileSync(eventsFile(dir, ms), 'utf8');
    } catch {
      continue;
    }
    for (const l of text.split('\n'))
      if (l.includes('"gate-miss"'))
        try {
          const e = JSON.parse(l) as MissEvent;
          if (e.kind === 'gate-miss' && e.run === run) return true;
        } catch {
          // a torn line
        }
  }
  return false;
}

export interface MissOpts {
  run: Run;
  log: (l: string) => void;
  now: () => number;
  board?: string | null; // the board dir; undefined → boardDir()
  deps?: Deps; // undefined → related.ts
}

// After a red verdict on `sha` from run `r`. Throws on a git or gh failure; ci.ts prints that as the check failing.
export async function missCheck(r: GhRun, sha: string, o: MissOpts): Promise<MissEvent | null> {
  const { run, log } = o;
  const failedLog = run('gh', ['run', 'view', String(r.databaseId), '--log-failed'], {
    timeoutMs: 120_000,
  });
  const root = run('git', ['rev-parse', '--show-toplevel']);
  const testFiles = fields(
    run('git', ['ls-tree', '-r', '--name-only', '-z', sha], { cwd: root }),
  ).filter(isTest);
  const failing = failingFiles(failedLog, testFiles);
  if (!failing.length)
    return (
      log(
        `gate:ci — no failing test file in run ${r.databaseId}'s failed logs (typecheck, lint or setup?): no miss check`,
      ),
      null
    );
  const mb = run('git', ['merge-base', 'origin/main', sha], { cwd: root });
  const diff = fields(
    run('git', ['diff', '--name-status', '--no-renames', '-z', mb, sha], { cwd: root }),
  );
  const changes: Change[] = [];
  for (let i = 0; i + 1 < diff.length; i += 2)
    changes.push({ path: diff[i + 1]!, deleted: diff[i] === 'D' });
  const p = await planWithBase(changes, testFiles, () =>
    run('git', ['show', `${mb}:${RULES_PATH}`], { cwd: root }),
  );
  const here =
    run('git', ['rev-parse', 'HEAD'], { cwd: root }) === sha &&
    run('git', ['status', '--porcelain', '-z'], { cwd: root }) === '';
  const j = judge(failing, p, o.deps ?? vitestDeps(run, root), here);
  if (!j.missed.length && !j.unsure.length)
    return (
      log(`gate:ci — the local gate:fast plan ran all ${failing.length} failing test file(s)`),
      null
    );

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const dir = o.board === undefined ? boardDir(run) : o.board;
  const e: MissEvent = {
    v: 1,
    t: stamp(o.now()),
    kind: 'gate-miss',
    name: dir ? (sessionNames(dir)[branch] ?? null) : null,
    branch,
    sha,
    run: r.databaseId,
    workflow: r.workflowName,
    url: r.url,
    failing,
    missed: j.missed,
    unsure: j.unsure,
  };
  const bar = '!!';
  log(
    `${bar} gate:ci — GATE MISS: ${j.missed.length} failing test file(s) the local gate:fast plan skipped${j.unsure.length ? `, ${j.unsure.length} it can't judge` : ''} (docs/ops/GATE.md → A miss)`,
  );
  for (const m of j.missed) log(`${bar}   missed  ${m.file}: ${m.why}`);
  for (const m of j.unsure) log(`${bar}   unsure  ${m.file}: ${m.why}`);
  if (!dir) log(`${bar} no board here: not logged`);
  else if (logged(dir, r.databaseId, o.now())) log(`${bar} already logged for run ${r.databaseId}`);
  else {
    const f = eventsFile(dir, o.now());
    if (!existsSync(join(dir, 'history'))) mkdirSync(join(dir, 'history'), { recursive: true });
    appendFileSync(f, `${JSON.stringify(e)}\n`);
    log(`${bar} logged to ${f} (kind gate-miss)`);
  }
  log(`${bar} send the hub an [info] with these lines: a miss means a gate rule is missing`);
  return e;
}
