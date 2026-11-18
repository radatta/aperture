// QUEUED (docs/ops/TOWER.md → Panels → NEXT): dispatch's autoStart lanes, approved but not started, in start order,
// each ready / after / held by the rule pace-watch.sh's exit 6 starts them by — a note starting LOW or HOLD holds it;
// an `after` lane still in devQueue or autoStart keeps it waiting. A lane with a lane file has started: it shows in
// NOW, and its autoStart entry is the `auto-start` stale item's to flag. Pure.
import type { AutoStartItem, QueueData } from './queue.ts';

export type QueuedItem = AutoStartItem & {
  state: 'ready' | 'after' | 'held';
  waitsOn: string[]; // the `after` lanes still queued
};

const HELD = /^(LOW|HOLD)/;

export function queuedView(q: QueueData | null, started: ReadonlySet<string>): QueuedItem[] {
  const items = q?.autoQueue ?? [];
  const live = new Set([
    ...(q?.devQueue ?? []).map((l) => l.branch),
    ...items.map((a) => a.branch),
  ]);
  return items
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !started.has(a.branch))
    .sort(
      (x, y) =>
        (x.a.order ?? Infinity) - (y.a.order ?? Infinity) ||
        rank(x.a.cls) - rank(y.a.cls) ||
        x.i - y.i,
    )
    .map(({ a }) => {
      const waitsOn = a.after.filter((b) => live.has(b));
      const state = HELD.test(a.note ?? '') ? 'held' : waitsOn.length ? 'after' : 'ready';
      return { ...a, state, waitsOn };
    });
}

const rank = (c: AutoStartItem['cls']) => (c === 'p0' ? 0 : c === 'p1' ? 1 : 2);

// One line per entry, shared by the brief and the page's details: `1 gate-trims p0 · after test-registry-check`.
export const queuedLine = (q: QueuedItem) =>
  `${q.order ?? '-'} ${q.branch}${q.cls ? ` ${q.cls}` : ''} · ${
    q.state === 'held'
      ? (q.note ?? 'held') // a held note starts LOW or HOLD itself
      : q.state === 'after'
        ? `after ${q.waitsOn.join(', ')}`
        : 'ready'
  }`;
