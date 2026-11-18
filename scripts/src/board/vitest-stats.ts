// A vitest globalSetup that leaves one line of run totals for heavy.sh to fold into its job event
// (docs/ops/SESSION-BOARD.md → Perf fields → `vitest`). Every vitest config loads it only while HEAVY_DETAIL_DIR is
// set (heavy.sh sets it; CI never does), so test output never changes: it is a globalSetup, not a reporter, because
// a lane shell's CLAUDECODE=1 makes vitest default to its `agent` reporter, which a `reporters` list would replace.
// The teardown runs once per project (app has two), so the file is named by pid and rewritten whole each time.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The parts of vitest's File / Task this reads (vitest 4.1: StateManager.getFiles(), the default reporter's sums).
export interface TaskLike {
  type?: string;
  mode?: string;
  result?: { state?: string; duration?: number };
  tasks?: TaskLike[];
}
export interface FileLike extends TaskLike {
  collectDuration?: number; // the default reporter's "import"
  setupDuration?: number;
  environmentLoad?: number;
  prepareDuration?: number;
}

export interface VitestStats {
  pkg: string;
  files: number;
  tests: number;
  failed: number;
  skipped: number;
  wallMs: number;
  ms: {
    transform: number | null;
    setup: number;
    import: number;
    tests: number;
    environment: number;
    prepare: number;
  };
}

const ms = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const round = (n: number) => Math.round(n);

function count(t: TaskLike, acc: { tests: number; failed: number; skipped: number }) {
  if (t.type === 'test') {
    acc.tests++;
    if (t.result?.state === 'fail') acc.failed++;
    else if (t.mode === 'skip' || t.mode === 'todo' || t.result?.state === 'skip') acc.skipped++;
  }
  for (const c of t.tasks ?? []) count(c, acc);
}

// transformTime is vitest's own running sum of module fetches (overlapping workers add up, so it can pass wall time).
export function summarize(
  pkg: string,
  files: FileLike[],
  transformTime: unknown,
  wallMs: number,
): VitestStats {
  const acc = { tests: 0, failed: 0, skipped: 0 };
  for (const f of files) count(f, acc);
  const sum = (k: (f: FileLike) => number | undefined) =>
    round(files.reduce((s, f) => s + ms(k(f)), 0));
  return {
    pkg,
    files: files.length,
    ...acc,
    wallMs: round(wallMs),
    ms: {
      transform:
        typeof transformTime === 'number' && Number.isFinite(transformTime)
          ? round(transformTime)
          : null,
      setup: sum((f) => f.setupDuration),
      import: sum((f) => f.collectDuration),
      tests: sum((f) => f.result?.duration),
      environment: sum((f) => f.environmentLoad),
      prepare: sum((f) => f.prepareDuration),
    },
  };
}

// The package's directory name under the repo (app, scripts, packages/shared, …), from the config's root.
export function pkgOf(root: string): string {
  const parts = root.split('/').filter(Boolean);
  return parts.at(-2) === 'packages' ? parts.slice(-2).join('/') : (parts.at(-1) ?? '');
}

interface ProjectLike {
  config?: { root?: string };
  vitest?: { state?: { getFiles?: () => FileLike[]; transformTime?: unknown } };
}

export default function setup(project: ProjectLike) {
  const t0 = performance.now();
  return () => {
    const dir = process.env.HEAVY_DETAIL_DIR;
    if (!dir) return;
    try {
      const state = project.vitest?.state;
      const s = summarize(
        pkgOf(project.config?.root ?? process.cwd()),
        state?.getFiles?.() ?? [],
        state?.transformTime,
        performance.now() - t0,
      );
      writeFileSync(join(dir, `vitest-${process.pid}.json`), `${JSON.stringify(s)}\n`);
    } catch {
      // a perf field never costs a test run its exit code
    }
  };
}
