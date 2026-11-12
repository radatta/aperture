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
  verdict: 'ok' | 'off' | 'unmodelled' | 'role' | 'empty' | 'unfound';
  kbUp: boolean;
}

// The newest passing result of a job: ids are `<UTC stamp>-ios-<scenario>-<job>-<4 hex>`, so they sort by time.
export function newestGreen(
  ids: string[],
  scenario: string,
  job: string,
  read: (id: string) => SimResultFile | null,
): string | null {
  const name = `ios-${scenario}-${job}`.slice(0, 43); // mailroom/ids.ts cuts an id's name there
  const re = new RegExp(
    `^\\d{8}T\\d{6}Z-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{4}$`,
  );
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
  const zero = { x: 0, y: 0, w: 0, h: 0 };
  const empty = (role: string, f: Frame) => !role || !f.w || !f.h;
  const job = `${r.scenario}/${r.name}`;
  return Object.entries(sim.reads ?? {}).map(([as, s]): CalRow => {
    const h = r.found?.[as];
    if (!h)
      return { job, as, sim: s.frame, here: zero, delta: zero, verdict: 'unfound', kbUp: false };
    const delta = {
      x: h.frame.x - s.frame.x,
      y: h.frame.y - s.frame.y,
      w: h.frame.w - s.frame.w,
      h: h.frame.h - s.frame.h,
    };
    // iOS reads a filled field over its text as the text run (IOS-CHECK.md → Reading the page): not comparable.
    const verdict: CalRow['verdict'] =
      empty(s.role, s.frame) || empty(h.role, h.frame)
        ? 'empty'
        : !h.modelled
          ? 'unmodelled'
          : h.role !== s.role
            ? 'role'
            : Object.values(delta).every((d) => Math.abs(d) < NEAR_MISS_PT)
              ? 'ok'
              : 'off';
    return { job, as, sim: s.frame, here: h.frame, delta, verdict, kbUp: h.kbUp };
  });
}

const box = (f: Frame) => `${f.x},${f.y} ${f.w}x${f.h}`;
// OK needs no frame off, and evidence: a keyboard-down and a keyboard-up frame compared (the keyboard model is what a
// runtime change moves). Jobs with no green run and reads the check never made are listed, never dropped.
export function formatCalibration(
  rows: CalRow[],
  sources: string[],
  noGreen: string[] = [],
): { ok: boolean; text: string } {
  const good = rows.filter((r) => r.verdict === 'ok');
  const off = rows.filter((r) => r.verdict === 'off');
  const ok = !off.length && good.some((r) => r.kbUp) && good.some((r) => !r.kbUp);
  const why = {
    ok: '',
    off: `off by ${NEAR_MISS_PT}+ pt: re-measure`,
    unmodelled: "not compared: a page field's keyboard isn't modelled",
    role: 'not compared: iOS read another role here',
    empty: 'not compared: an empty read',
    unfound: 'not compared: the check never found it',
  };
  const lines = rows.map(
    (r) =>
      `  ${r.verdict.padEnd(10)} ${`${r.job} ${r.as}${r.kbUp ? ' (keyboard up)' : ''}`.padEnd(52)} sim ${box(r.sim).padEnd(16)} here ${box(r.here).padEnd(16)} Δ ${r.delta.x},${r.delta.y} ${r.delta.w}x${r.delta.h}  ${why[r.verdict]}`,
  );
  const tail = ok
    ? []
    : [
        off.length
          ? `  re-measure: KEYBOARD_VIEWPORT_H and SAFE in ios-probe/check.ts until every frame sits within ${NEAR_MISS_PT - 1} pt`
          : '  too little evidence: needs green runs with keyboard-down and keyboard-up frames (rerun the iOS scenarios)',
      ];
  return {
    ok,
    text: [
      `iOS probe calibration: ${ok ? 'OK' : 'OFF'} — ${good.length} frames within ${NEAR_MISS_PT - 1} pt (${good.filter((r) => r.kbUp).length} keyboard up), ${off.length} off (against ${sources.join(', ') || 'no green run'})`,
      ...lines,
      ...noGreen.map((j) => `  no green run ${j}: not compared`),
      ...tail,
    ].join('\n'),
  };
}
