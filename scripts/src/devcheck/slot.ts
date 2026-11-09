// Which dev slot a run targets — the one whose lock this branch holds (docs/ops/DEV-CHECK.md → Dev slots). There is no
// flag: the lock is the one place a slot is chosen, so a run can't be aimed at a stack another branch is testing.
// Read-only, with the container's own token — the same peek as scripts/board/devlock.sh: `git ls-remote` for the two
// refs, then each tag's message (the holder JSON). No lock held → slot A, as every run was before slot B: a check of
// main's deploy (the fails-on-main baseline) holds none. Expiry doesn't matter: the branch deployed there, and
// another branch's take-over would show as a different holder.
import { SLOTS, type Slot } from './config';

export interface SlotDeps {
  lsRemote: () => Promise<string>; // `git ls-remote origin refs/locks/dev refs/locks/devb`
  tagMessage: (sha: string) => Promise<string>; // `gh api repos/<repo>/git/tags/<sha> --jq .message`
}

export interface SlotPick {
  slot: Slot;
  why: string;
}

const holderBranch = (message: string): string | undefined => {
  try {
    const h = JSON.parse(message) as { branch?: unknown };
    return typeof h.branch === 'string' ? h.branch : undefined;
  } catch {
    return undefined;
  }
};

export async function pickSlot(branch: string, deps: SlotDeps): Promise<SlotPick> {
  const refs = new Map<string, string>();
  for (const line of (await deps.lsRemote()).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  for (const slot of SLOTS) {
    const tag = refs.get(`refs/locks/${slot}`);
    if (tag && holderBranch(await deps.tagMessage(tag)) === branch)
      return { slot, why: `${branch} holds the ${slot} lock` };
  }
  return { slot: 'dev', why: `${branch} holds no dev lock — dev (slot A), as before slot B` };
}
