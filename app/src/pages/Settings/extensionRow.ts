import type { Sitting } from '@aperture/shared';

// Settings → LeetCode's extension line: the build Safari ran at the newest sitting's Start against the one this
// app was built with (extension/README.md → Versions). Known only as of that Start, and the words say so.
export interface ExtensionRow {
  text: string;
  rebuild: boolean; // Safari's copy is behind: the line asks for a rebuild
}

const parse = (v: string | null | undefined) => {
  const m = v ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
// <0 when a is older than b, 0 the same, >0 newer; null when either isn't x.y.z.
export function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export function extensionRow(sittings: readonly Sitting[], latest: string): ExtensionRow {
  const newest = sittings.reduce<Sitting | null>(
    (n, s) => (!n || s.startedAt > n.startedAt ? s : n),
    null,
  );
  if (!newest)
    return {
      text: `Extension: latest ${latest}. Your next Start shows which build Safari runs.`,
      rebuild: false,
    };
  const installed = newest.extensionVersion ?? null;
  const cmp = compareVersions(installed, latest);
  if (installed == null || cmp == null)
    return {
      text: `Extension: the last Start came from a build older than ${latest}\u00a0— rebuild needed.`,
      rebuild: true,
    };
  if (cmp < 0)
    return { text: `Extension: installed ${installed}, latest ${latest}\u00a0— rebuild needed.`, rebuild: true };
  if (cmp > 0)
    return { text: `Extension: installed ${installed}; this app was built with ${latest}.`, rebuild: false };
  return { text: `Extension: ${installed}, up to date as of your last Start.`, rebuild: false };
}
