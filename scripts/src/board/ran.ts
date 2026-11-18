// Mac-line "ran" markers (docs/ops/HUB.md → Mac lines): a line the hub hands the maintainer ends with a suffix that
// writes the line's exit code into <board>/ran/<id> over the shared mount, and merge-watch.sh wakes the hub with it,
// so "ran it" needs no typing. The suffix only ever writes a number; nothing on the Mac reads the folder; the container
// reads a file only when its name matches RAN_ID, and at most a few bytes of it, as a number.
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE } from '../mac-root.ts';

export const RAN_ID = /^[a-z0-9][a-z0-9-]{0,31}$/; // merge-watch.sh holds the same pattern
const SLUG = /^[a-z0-9][a-z0-9-]{0,26}$/; // leaves room for -<4 base36>

// `<slug>-<4 base36 of the epoch second>`: a rerun of the same step a little later gets its own file.
export function ranId(slug: string, now: Date): string {
  if (!SLUG.test(slug))
    throw new Error(
      `ran: the slug must be lowercase letters, digits and -, at most 27 (got ${JSON.stringify(slug)})`,
    );
  const t = Math.floor(now.getTime() / 1000) % 36 ** 4;
  return `${slug}-${t.toString(36).padStart(4, '0')}`;
}

// Appended to the whole `cd <mac-repo> && a && b` line: `$?` after the chain is the chain's status (the first
// failure's, or the last command's); `>|` writes past zsh's noclobber; the path is absolute because the chain may
// `cd` into a worktree. Join the line with && only: a `;` inside would record only the part after it.
export function ranSuffix(root: string, id: string): string {
  if (!RAN_ID.test(id)) throw new Error(`ran: bad id ${JSON.stringify(id)}`);
  return `; echo $? >| ${root}/localNotes/board/ran/${id}`;
}

// What `pnpm board ran <slug>` prints: the suffix, plus the placeholder note when the Mac root is unknown.
export const ranOut = (root: string, id: string) =>
  ranSuffix(root, id) + (root === MAC_PLACEHOLDER ? `\n${MAC_ROOT_NOTE}` : '');
