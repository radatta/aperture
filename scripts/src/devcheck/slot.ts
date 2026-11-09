// Which dev slot a run targets — the one whose lock this branch holds (docs/ops/DEV-CHECK.md → Dev slots). There is no
// flag: the lock is the one place a slot is chosen, so a run can't be aimed at a stack another branch is testing.
// Read-only, with the container's own token — the same peek as scripts/board/devlock.sh: `git ls-remote` for the two
// refs, then each tag's message (the holder JSON). No lock of its own → slot A, as every run was before slot B — a check
// of main's deploy (the fails-on-main baseline) holds none — unless another branch holds slot A live: then the run is
// refused (NO_LOCK), since it would sweep and write into that branch's test. Its own lock's expiry doesn't matter: the
// branch deployed there, and another branch's take-over would show as a different holder.
import { SLOTS, type Slot } from './config';
import { DevcheckError } from './errors';

export interface SlotDeps {
  lsRemote: () => Promise<string>; // `git ls-remote origin refs/locks/dev refs/locks/devb`
  tagMessage: (sha: string) => Promise<string>; // `gh api repos/<repo>/git/tags/<sha> --jq .message`
  now?: () => number;
}

export interface SlotPick {
  slot: Slot;
  why: string;
}

const holderOf = (message: string): { branch?: string; expiresAt?: string } => {
  try {
    const h = JSON.parse(message) as { branch?: unknown; expiresAt?: unknown };
    return {
      ...(typeof h.branch === 'string' ? { branch: h.branch } : {}),
      ...(typeof h.expiresAt === 'string' ? { expiresAt: h.expiresAt } : {}),
    };
  } catch {
    return {}; // unreadable: the next acquire takes it over, so it holds nothing
  }
};

export async function pickSlot(branch: string, deps: SlotDeps): Promise<SlotPick> {
  const refs = new Map<string, string>();
  for (const line of (await deps.lsRemote()).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  const holders = new Map<Slot, { branch?: string; expiresAt?: string }>();
  for (const slot of SLOTS) {
    const tag = refs.get(`refs/locks/${slot}`);
    const h = tag ? holderOf(await deps.tagMessage(tag)) : {};
    if (h.branch === branch) return { slot, why: `${branch} holds the ${slot} lock` };
    holders.set(slot, h);
  }
  const a = holders.get('dev');
  if (a?.branch && Date.parse(a.expiresAt ?? '') > (deps.now ?? Date.now)())
    throw new DevcheckError(
      'NO_LOCK',
      `${branch || 'this branch'} holds no dev lock and ${a.branch} is testing on dev until ${a.expiresAt} — \`pnpm bot deploy-dev\` takes a slot first`,
    );
  return { slot: 'dev', why: `${branch} holds no dev lock — dev (slot A), free, as before slot B` };
}
