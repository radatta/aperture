// Real merge conflicts between lanes (docs/ops/SESSION-BOARD.md → Overlaps): `git merge-tree --write-tree` of each
// lane's head against origin/main and against every other lane, read-only — no checkout, no index. File overlap
// (overlap.ts) says two lanes touch the same file; this says whether git can merge them.
// Every merge is cached by its two shas, so a run only merges what moved since the last; a time budget stops a
// cold run early and the rest resumes next run. Git runs through an injected runner so tests script it.

export type GitRun = (args: string[], timeoutMs: number) => { code: number | null; stdout: string };

export type Head = {
  branch: string;
  sha: string;
  base: string; // merge-base with origin/main
  files: string[]; // committed since `base`
  at: number; // the head commit's committer time, epoch ms
};

// A merge's tree and its conflicted paths ([] = clean). Only a real answer is cached: an error never is.
export type Merge = { tree: string; files: string[] };

export type Cache = {
  v: 1;
  pairs: Record<string, Merge>; // key: the two shas, sorted, space-joined
  // per lane head: `at` the main commit its change landed in, or `through` the last main commit checked
  landed: Record<string, { at?: string; through?: string }>;
};

export type Conflict = { a: string; b: string; files: string[] }; // b === 'main': against origin/main

export type Check = {
  conflicts: Conflict[];
  clean: [string, string][]; // lane pairs git merges cleanly at both heads
  landed: string[]; // squash-merged, worktree not cleaned up
  stale: string[]; // head older than STALE_DAYS
  pending: number; // merges left for the next run (budget or timeout)
  cache: Cache;
};

export const MAIN = 'main';
export const STALE_DAYS = 7;
export const RUN_BUDGET_MS = 10_000;
export const MERGE_TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 200; // main commits tried per lane when looking for its squash

export const emptyCache = (): Cache => ({ v: 1, pairs: {}, landed: {} });

export function parseCache(text: string | null): Cache {
  try {
    const c = JSON.parse(text ?? '') as Cache;
    if (c?.v === 1 && c.pairs && c.landed) return c;
  } catch {
    // a torn or old file starts over: it's only a cache
  }
  return emptyCache();
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// `--name-only -z`: the tree oid, then one NUL-terminated path per conflicted file. Exit 0 clean, 1 conflict —
// but a bad ref also exits 1 (with nothing on stdout), so a conflict needs the oid too. Anything else: null.
export function mergeTree(run: GitRun, a: string, b: string): Merge | null {
  const r = run(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b],
    MERGE_TIMEOUT_MS,
  );
  if (r.code !== 0 && r.code !== 1) return null;
  const [tree = '', ...rest] = r.stdout.split('\0');
  if (!OID.test(tree)) return null;
  const files = [...new Set(rest.filter(Boolean))].sort();
  if ((r.code === 1) !== files.length > 0) return null; // exit and output disagree: don't trust either
  return { tree, files };
}

const key = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);

export type Input = {
  heads: Head[];
  main: { sha: string; tree: string };
  now: number;
  budgetMs?: number;
};

export function check(input: Input, run: GitRun, old: Cache, clock = Date.now): Check {
  const { main } = input;
  const deadline = clock() + (input.budgetMs ?? RUN_BUDGET_MS);
  const cache: Cache = { v: 1, pairs: {}, landed: {} };
  let pending = 0;

  // A cached merge, or a new one while the budget lasts; null = not known this run.
  const merge = (x: string, y: string): Merge | null => {
    const k = key(x, y);
    const hit = cache.pairs[k] ?? old.pairs[k];
    if (hit) return (cache.pairs[k] = hit);
    if (clock() >= deadline) return null;
    const m = mergeTree(run, ...(x < y ? ([x, y] as const) : ([y, x] as const)));
    if (m) cache.pairs[k] = m;
    return m;
  };

  const stale = input.heads
    .filter((h) => input.now - h.at > STALE_DAYS * 86400_000)
    .map((h) => h.branch);
  const live: Head[] = [];
  const landed: string[] = [];
  const mainHit = new Map<string, Merge>();

  for (const h of input.heads) {
    if (stale.includes(h.branch)) continue;
    const vsMain = merge(h.sha, main.sha);
    if (!vsMain) {
      pending++;
      continue;
    }
    const l = landedAt(h, vsMain, main, run, merge, old.landed[h.sha], () => clock() >= deadline);
    if (l.record) cache.landed[h.sha] = l.record;
    if (l.state === 'unknown') pending++;
    else if (l.state === 'landed') landed.push(h.branch);
    else {
      live.push(h);
      mainHit.set(h.branch, vsMain);
    }
  }

  const conflicts: Conflict[] = [];
  for (const h of live) {
    const files = mainHit.get(h.branch)!.files;
    if (files.length) conflicts.push({ a: h.branch, b: MAIN, files });
  }
  const clean: [string, string][] = [];
  const sorted = [...live].sort((x, y) => x.branch.localeCompare(y.branch));
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const m = merge(a.sha, b.sha);
      if (!m) {
        pending++;
        continue;
      }
      // a lane behind main conflicts with every rebased neighbour on its main conflicts: say those once, vs main
      const known = new Set([...mainHit.get(a.branch)!.files, ...mainHit.get(b.branch)!.files]);
      const files = m.files.filter((f) => !known.has(f));
      if (files.length) conflicts.push({ a: a.branch, b: b.branch, files });
      else if (!m.files.length) clean.push([a.branch, b.branch]);
    }

  // Eviction: what this run used, plus what it didn't reach whose shas are all still current (a lane left
  // pending keeps its entries); a sha that is no longer a head or main drops out.
  const current = new Set([main.sha, ...input.heads.map((h) => h.sha)]);
  for (const [k, m] of Object.entries(old.pairs))
    if (!cache.pairs[k] && k.split(' ').every((s) => current.has(s))) cache.pairs[k] = m;
  for (const [k, l] of Object.entries(old.landed))
    if (!cache.landed[k] && current.has(k)) cache.landed[k] = l;

  return { conflicts, clean, landed, stale, pending, cache };
}

type Landed = { state: 'live' | 'landed' | 'unknown'; record?: { at?: string; through?: string } };

// A squash merge puts the lane's change on main as one new commit, so its branch never looks merged. It has landed
// when merging it into main changes nothing; failing that (main moved on over the same lines), when merging it
// into some first-parent main commit since its base, one touching its files, gives that commit's tree exactly.
function landedAt(
  h: Head,
  vsMain: Merge,
  main: { sha: string; tree: string },
  run: GitRun,
  merge: (x: string, y: string) => Merge | null,
  prev: { at?: string; through?: string } | undefined,
  spent: () => boolean,
): Landed {
  if (prev?.at) return { state: 'landed', record: prev };
  if (!vsMain.files.length && vsMain.tree === main.tree)
    return { state: 'landed', record: { at: main.sha } };
  if (prev?.through === main.sha) return { state: 'live', record: prev };
  if (!h.files.length) return { state: 'live', record: { through: main.sha } };
  const from = prev?.through ?? h.base;
  const r = run(
    [
      'log',
      '--first-parent',
      '--reverse',
      '--format=%H %T',
      `${from}..${main.sha}`,
      '--',
      ...h.files,
    ],
    MERGE_TIMEOUT_MS,
  );
  if (r.code !== 0) return { state: 'unknown', record: prev };
  const commits = r.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter((p): p is [string, string] => p.length === 2 && OID.test(p[0]!) && OID.test(p[1]!))
    .filter(([c]) => c !== main.sha)
    .slice(-MAX_CANDIDATES);
  let through = prev?.through;
  for (const [c, tree] of commits) {
    if (spent()) return { state: 'unknown', record: through ? { through } : prev };
    const m = merge(h.sha, c);
    if (!m) return { state: 'unknown', record: through ? { through } : prev };
    if (!m.files.length && m.tree === tree) return { state: 'landed', record: { at: c } };
    through = c;
  }
  return { state: 'live', record: { through: main.sha } };
}
