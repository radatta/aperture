// The cache warm at `pnpm lanes start` (docs/ops/LANES.md → Start, step 9): once the session is live, the new
// worktree's scripts/board/warm.sh runs detached, so the lane's first typecheck and lint find tsc -b's and eslint's
// caches warm. Only on a calm box (the pace rules, bar the spacing this start just stamped); a skip or a failed spawn
// is a log line, never a failed start.
import type { Deps } from './state.ts';
import { calmBlock } from './pace.ts';

export const WARM_LOG = 'localNotes/warm.log';
const SPAWN_TIMEOUT_MS = 5000; // setsid -f returns once it forked (9 ms measured); warm.sh redirects before any work

export function warmCaches(d: Deps, wt: string): void {
  const log = `${wt}/${WARM_LOG}`;
  const busy = calmBlock(d);
  if (busy) {
    const line = `warm: skipped, the box isn't calm (${busy})`;
    d.log(line);
    try {
      d.fs.write(log, `${line}\n`);
    } catch {
      // the start's own log line above is the record
    }
    return;
  }
  try {
    // The worktree's copy, not main's: bash reads a script as it runs, and sync-main moves the main checkout next.
    d.run('setsid', ['-f', 'bash', `${wt}/scripts/board/warm.sh`, log], {
      cwd: wt,
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    d.log(`warm: typecheck + lint started in the background (${WARM_LOG})`);
  } catch (err) {
    d.log(`warning: the cache warm didn't start: ${(err as Error).message}`);
  }
}
