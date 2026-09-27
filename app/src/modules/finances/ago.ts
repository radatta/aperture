const MIN = 60_000;

// "just now" / "12 min ago" / "3 h ago" / "2 days ago" — how stale the bank data is.
export function fmtAgo(epochMs: number, now: number): string {
  const d = Math.max(0, now - epochMs);
  if (d < MIN) return 'just now';
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} min ago`;
  if (d < 24 * 60 * MIN) return `${Math.floor(d / (60 * MIN))} h ago`;
  const days = Math.floor(d / (24 * 60 * MIN));
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
