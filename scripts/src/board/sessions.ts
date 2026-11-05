// Board session registry reads shared by the board CLI and the bot (lock wait names the holder's session).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// branch → registered session name (the SendMessage address), from board/sessions/*.json; gone sessions skipped.
export function sessionNames(boardDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let files: string[];
  try {
    files = readdirSync(join(boardDir, 'sessions')).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(boardDir, 'sessions', f), 'utf8'));
      if (s.branch && s.name && s.state !== 'gone') out[s.branch] = s.name;
    } catch {
      // half-written by another session — next tick
    }
  }
  return out;
}
