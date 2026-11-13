// The points a sim op reads, in the runner's order (tools/mailroom/jobs/sim.sh → sim_points): a scan's `hint` first,
// then a 30-pt grid within `radius` (default 40) of `near`, nearest first, ties in generation order (dx outer, dy inner);
// or a straight `scan`, 30 pt a step, `to` included. Points off the SIM_W×SIM_H screen are dropped from the grid (a
// scan and its hint are validated on it).
import { SIM_H, SIM_W } from '../mailroom/sim';

export interface Pt {
  x: number;
  y: number;
}
export interface Where {
  near?: Pt;
  radius?: number;
  scan?: { x: number; from: number; to: number };
  hint?: Pt;
}

export function simPoints(w: Where): Pt[] {
  const hint = w.hint ? [{ x: Math.floor(w.hint.x), y: Math.floor(w.hint.y) }] : [];
  return [...hint, ...gridOrScan(w)];
}

function gridOrScan(w: Where): Pt[] {
  if (w.near) {
    const k = Math.floor((w.radius ?? 40) / 30);
    const o = Array.from({ length: 2 * k + 1 }, (_, i) => (i - k) * 30);
    const grid = o.flatMap((dx) =>
      o.map((dy) => ({ d: dx * dx + dy * dy, x: w.near!.x + dx, y: w.near!.y + dy })),
    );
    return grid
      .map((p, i) => ({ ...p, i }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .filter((p) => p.x >= 0 && p.x <= SIM_W && p.y >= 0 && p.y <= SIM_H)
      .map(({ x, y }) => ({ x: Math.floor(x), y: Math.floor(y) }));
  }
  const s = w.scan!;
  const pts: Pt[] = [];
  if (s.to >= s.from) for (let y = s.from; y <= s.to; y += 30) pts.push({ x: Math.floor(s.x), y });
  else for (let y = s.from; y >= s.to; y -= 30) pts.push({ x: Math.floor(s.x), y });
  return pts;
}

// The points a read-back could land on instead of the hit when the layout settles a step away from where the find
// saw it. The dock settles vertically, so: the grid's points in the hit's column, or the scan's points either side.
// A hit on the hint: a step above and below it, as a scan's.
export function neighbours(w: Where, pts: Pt[], hit: number): Pt[] {
  const h = pts[hit]!;
  const first = w.hint ? 1 : 0; // the grid's or scan's own points start after the hint
  if (w.hint && hit === 0)
    return [
      { x: h.x, y: h.y - 30 },
      { x: h.x, y: h.y + 30 },
    ];
  if (w.near) return pts.filter((p, i) => i >= first && i !== hit && p.x === h.x);
  return [pts[hit - 1], pts[hit + 1]].filter(
    (p, i): p is Pt => !!p && (i === 1 || hit - 1 >= first),
  );
}
