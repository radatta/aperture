// The probe check's calibration (IOS-CHECK.md → Probe check): the frames the check finds against the frames AXe
// recorded in the newest green Simulator run of each job (.hostjobs/results/<id>/result.json `reads`). Rerun after an
// iOS runtime, Xcode or AXE_VERSION change: `pnpm ios-probe --calibrate`.
import type { Frame } from './ax';
import { NEAR_MISS_PT, type JobResult } from './check';

export interface SimResultFile {
  status: string;
  reads?: Record<string, { role: string; frame: Frame }>;
}
export interface CalRow {
  job: string;
  as: string;
  sim: Frame;
  here: Frame;
  delta: Frame; // here − sim
  verdict: 'ok' | 'off' | 'unmodelled' | 'role';
}

// The newest passing result of a job: ids are `<UTC stamp>-ios-<scenario>-<job>-<4 hex>`, so they sort by time.
export function newestGreen(
  ids: string[],
  scenario: string,
  job: string,
  read: (id: string) => SimResultFile | null,
): string | null {
  const re = new RegExp(`^\\d{8}T\\d{6}Z-ios-${scenario}-${job}-[0-9a-f]{4}$`);
  for (const id of ids
    .filter((d) => re.test(d))
    .sort()
    .reverse()) {
    const r = read(id);
    if (r?.status === 'pass' && r.reads && Object.keys(r.reads).length) return id;
  }
  return null;
}

export function compareJob(r: JobResult, sim: SimResultFile): CalRow[] {
  return Object.entries(sim.reads ?? {}).flatMap(([as, s]) => {
    const h = r.found?.[as];
    if (!h) return [];
    const delta = {
      x: h.frame.x - s.frame.x,
      y: h.frame.y - s.frame.y,
      w: h.frame.w - s.frame.w,
      h: h.frame.h - s.frame.h,
    };
    // iOS reads a filled field over its text as the text run (IOS-CHECK.md → Reading the page): not comparable.
    const verdict: CalRow['verdict'] = !h.modelled
      ? 'unmodelled'
      : h.role !== s.role
        ? 'role'
        : Object.values(delta).every((d) => Math.abs(d) < NEAR_MISS_PT)
          ? 'ok'
          : 'off';
    return [{ job: `${r.scenario}/${r.name}`, as, sim: s.frame, here: h.frame, delta, verdict }];
  });
}

const box = (f: Frame) => `${f.x},${f.y} ${f.w}x${f.h}`;
export function formatCalibration(
  rows: CalRow[],
  sources: string[],
): { ok: boolean; text: string } {
  const off = rows.filter((r) => r.verdict === 'off');
  const ok = rows.some((r) => r.verdict === 'ok') && !off.length;
  const why = {
    ok: '',
    off: `off by ${NEAR_MISS_PT}+ pt: re-measure`,
    unmodelled: "not compared: a page field's keyboard isn't modelled",
    role: 'not compared: iOS read another role here',
  };
  const lines = rows.map(
    (r) =>
      `  ${r.verdict.padEnd(10)} ${`${r.job} ${r.as}`.padEnd(44)} sim ${box(r.sim).padEnd(16)} here ${box(r.here).padEnd(16)} Δ ${r.delta.x},${r.delta.y} ${r.delta.w}x${r.delta.h}  ${why[r.verdict]}`,
  );
  return {
    ok,
    text: [
      `iOS probe calibration: ${ok ? 'OK' : 'OFF'} — ${rows.filter((r) => r.verdict === 'ok').length} frames within ${NEAR_MISS_PT - 1} pt, ${off.length} off (against ${sources.join(', ') || 'no green run'})`,
      ...lines,
      ...(ok
        ? []
        : [
            `  re-measure: KEYBOARD_VIEWPORT_H and SAFE in ios-probe/check.ts until the frames sit within ${NEAR_MISS_PT - 1} pt`,
          ]),
    ].join('\n'),
  };
}
