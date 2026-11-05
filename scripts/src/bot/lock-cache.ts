// The board's copy of the dev lock (docs/ops/SESSION-BOARD.md → Dev lock line): every lock read or change the bot
// makes is written to <board>/devlock.json, so `board.sh status` and the SessionStart hook show the real
// refs/locks/dev without a token. scripts/board/devlock.sh writes the same shape from its own read-only peek.
// Best effort: no board dir (CI, the Mac) or any write error → nothing, never a failed bot command.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionNames } from '../board/sessions.ts';
import type { Holder } from './lock.ts';
import type { Run } from './sh.ts';

// Shape shared with devlock.sh. Expiry is never judged here: readers compute it at read time.
export interface LockCache {
  v: 1;
  t: string;
  source: 'bot' | 'peek';
  holder: Holder | null;
}

// lib.sh's order: APERTURE_BOARD_DIR, then /workspace/localNotes/board, then <main checkout>/localNotes/board.
export function boardDir(run: Run): string | null {
  if (process.env.APERTURE_BOARD_DIR) return process.env.APERTURE_BOARD_DIR;
  if (existsSync('/workspace/localNotes')) return '/workspace/localNotes/board';
  try {
    const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return join(dirname(common), 'localNotes', 'board');
  } catch {
    return null;
  }
}

export function writeLockCache(dir: string | null, holder: Holder | null, nowMs: number): void {
  if (!dir || !existsSync(dir)) return;
  const file = join(dir, 'devlock.json');
  try {
    const body: LockCache = { v: 1, t: new Date(nowMs).toISOString(), source: 'bot', holder };
    writeFileSync(`${file}.tmp.${process.pid}`, JSON.stringify(body) + '\n');
    renameSync(`${file}.tmp.${process.pid}`, file);
  } catch {
    // a read-only or vanished board — the next read or peek writes it
  }
}

// The live session working on `branch`, if the board knows one — the SendMessage address of the lock holder.
export const holderSession = (dir: string | null, branch: string): string | undefined =>
  dir ? sessionNames(dir)[branch] : undefined;
