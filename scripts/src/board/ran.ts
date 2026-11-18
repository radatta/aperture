// Mac-line "ran" markers: a line the hub hands the maintainer ends with a suffix that writes the line's exit code
// into <board>/ran/<id> over the shared mount, and merge-watch.sh wakes the hub with it, so "ran it" needs no typing.
// The suffix's shape and its trust boundary: docs/ops/HUB.md → Mac lines; the reader's checks: SESSION-BOARD.md →
// Watchers → merge.
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

// Appended to the whole `cd <mac-repo> && a && b` line. `r=$?` first, inside the subshell, is the chain's status;
// `set -C` then makes `>` create-only, so a regular file already at the path, or a symlink to one (one the container
// could plant, to aim the write at a Mac file), is refused, never written through; a symlink to a FIFO or a device
// is not (HUB.md → Mac lines → the residuals). The path is absolute: the chain may `cd` away.
export function ranSuffix(root: string, id: string): string {
  if (!RAN_ID.test(id)) throw new Error(`ran: bad id ${JSON.stringify(id)}`);
  return `; (r=$?; set -C; echo $r > ${root}/localNotes/board/ran/${id})`;
}

// What `pnpm board ran <slug>` prints: the suffix, plus the placeholder note when the Mac root is unknown.
export const ranOut = (root: string, id: string) =>
  ranSuffix(root, id) + (root === MAC_PLACEHOLDER ? `\n${MAC_ROOT_NOTE}` : '');
