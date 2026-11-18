// The probe check (IOS-CHECK.md → Probe check): an iOS plan's ops replayed against the app in a headless engine, so
// a UI change that moves a probed element off its point — or puts another control on it — fails before a Simulator
// run. It mirrors the runner's reads (points.ts, ax.ts); what only an iPhone does is skipped with a reason, never
// silently. A first filter: the Simulator stays the proof.
import { SIM_H, SIM_W, TAP_DENY, type IosOp } from '../mailroom/sim';
import { isControl, matches, seenAs, type AxEl, type Frame } from './ax';
import { neighbours, simPoints, type Pt, type Where } from './points';

// The engine seam: everything the check asks of a browser. engine.ts implements it on Playwright.
export interface ProbePage {
  open(): Promise<void>; // a fresh load of Home, safe areas applied, keyboard down
  read(p: Pt): Promise<AxEl | null>;
  click(p: Pt): Promise<void>;
  type(text: string): Promise<void>;
  backspace(n: number): Promise<void>;
  blur(): Promise<void>;
  scrollTop(): Promise<void>;
  scroll(dy: number): Promise<void>;
  // Whether focus sits in a fixed layer (the dock, a modal) — the case the keyboard model is calibrated for.
  focusInFixedLayer(): Promise<boolean>;
  keyboard(up: boolean): Promise<void>;
  settle(): Promise<void>;
  shot(path: string): Promise<void>;
}

// Every reason an op isn't checked here. Closed: an op the check can't place is a failure (UNMODELLED), not a skip.
export const SKIP = {
  signIn: 'stub mode signs nobody in',
  lifecycle: "the app's process and build are the Simulator's",
  aboveKeyboard: "the keyboard is a viewport model here; clearing it is the Simulator's proof",
  sameWidth: 'no zoom on focus in a desktop engine',
  wait: 'a wait is a settle here: nothing animates in from the network',
  shot: "screenshots are the Simulator's",
  devData: 'needs dev data the stub lacks',
  pageKeyboard: "a page field's keyboard isn't modelled (iOS scrolls the field)",
} as const;
export type SkipReason = keyof typeof SKIP;

// Ops that need data only dev has, by scenario and label. An entry that matches no op fails the run (a stale skip).
export const DEV_DATA: { scenario: string; label: string; why: string }[] = [
  {
    scenario: 'category-suggest-ios',
    label: 'Use suggested category',
    why: 'the chip needs a Garden task history (the scenario seeds it on dev)',
  },
];

// The keyboard model, calibrated against the Simulator (2026-11-12, jobs …180905Z…-capture-be55 and
// …181031Z…-done-form-ab97, iOS 27.0): with a dock field focused, a 440×550 viewport and no bottom inset put the capture
// bar, the Log toggle and Save log at AXe's frames exactly; keyboard down matched at 440×956 with insets 59/34.
// Fields in the page's flow aren't modelled: iOS scrolls them (Search tasks moved 45 pt), so their probes are scans.
export const VIEWPORT = { w: 440, h: 956 };
export const KEYBOARD_VIEWPORT_H = 550;
export const SAFE = { top: 59, bottom: 34 };
// sim.sh's SIM_XS_NAV / SIM_Y_NAV: the points sim_nav_probe reads before any swipe (check.test.ts reads them out of
// sim.sh).
export const NAV_XS = [38, 88, 136, 205, 276, 332, 380, 268, 395];
export const NAV_Y = 168;
const SWIPED_TABS = ['Finances', 'Inbox', 'Settings'];
// sim_op_nav's `sleep 2` before each read-back, in engine settles (SETTLE_MS, 300 ms): the landmark may show any
// time within it.
export const NAV_READS = 7;
// sim.sh's sim_nav_mark: the page landmark nav reads back after the tab tap (check.test.ts reads it out of sim.sh). A
// tab without one is noted "page not confirmed" by the runner, and passes here as there.
export const NAV_MARKS: Record<string, { label: string; role: string; x: number; ys: number[] }> = {
  Tasks: { label: 'Bulk add', role: 'AXButton', x: 369, ys: [232, 212, 252] },
};
// sim.sh's write-button guard on the matched element (sim_op_tap → DENIED), as sim.ts validates the op's label.
const denied = (label: string) => {
  const l = label.toLowerCase().replace(/^ +/, '').replace(/ +$/, '');
  return TAP_DENY.some((d) => l === d || l.startsWith(`${d} `));
};

// The calibration's largest error was 7 pt (the Done form's Reflection, keyboard up): a match only this close to a
// probe point is a warning that the probe is fragile — neither a pass the Simulator might not repeat nor a fail.
export const NEAR_MISS_PT = 8;
const NUDGES: [number, number][] = [NEAR_MISS_PT / 2, NEAR_MISS_PT].flatMap(
  (d): [number, number][] => [
    [0, -d],
    [0, d],
    [-d, 0],
    [d, 0],
  ],
);

const SETTLE_NUDGES = [-NEAR_MISS_PT / 2, NEAR_MISS_PT / 2, -NEAR_MISS_PT, NEAR_MISS_PT];

export type Status = 'pass' | 'fail' | 'skip' | 'warn';
export interface OpResult {
  i: number;
  op: string;
  status: Status;
  note: string;
}
export interface JobResult {
  scenario: string;
  name: string;
  ops: OpResult[];
  ok: boolean;
  // What each `as` resolved to, for the calibration (calibrate.ts); `modelled` false under a page field's keyboard.
  found?: Record<string, { role: string; frame: Frame; modelled: boolean; kbUp: boolean }>;
}

interface Found {
  el: AxEl;
  at: Pt;
  modelled?: boolean;
  kbUp?: boolean;
}

const describe = (o: IosOp): string => {
  const w = o as IosOp & Where & { label?: string; as?: string; tab?: string; text?: string };
  const where = w.near
    ? ` (${w.near.x},${w.near.y}) r${w.radius ?? 40}`
    : w.scan
      ? ` scan x${w.scan.x} ${w.scan.from}→${w.scan.to}`
      : '';
  const what = w.label ? ` "${w.label}"` : w.tab ? ` ${w.tab}` : w.text ? ` "${w.text}"` : '';
  return `${o.op}${what}${where}${w.as ? ` as ${w.as}` : ''}`;
};

export async function checkJob(
  page: ProbePage,
  job: { scenario: string; name: string; steps: IosOp[] },
  o: { shot?: (name: string) => string } = {},
): Promise<JobResult> {
  const ops: OpResult[] = [];
  const found = new Map<string, Found>();
  const skipped = new Map<string, string>(); // an `as` whose op was skipped → why
  // Names a later `keys … in` / `erase … in` reads back at the point they were found — the pill's failure mode.
  const readBack = new Set(
    job.steps.flatMap((s) => ('in' in s && typeof s.in === 'string' ? [s.in] : [])),
  );
  const devData = (label?: string) =>
    DEV_DATA.find((d) => d.scenario === job.scenario && d.label === label);
  let kbUp = false;
  let pageKeyboard = false; // a page field has focus: its keyboard and iOS's scroll aren't modelled
  let failed = false;

  const add = (i: number, op: IosOp, status: Status, note: string) =>
    ops.push({ i, op: describe(op), status, note });

  await page.open();
  if (job.steps[0]?.op !== 'launch')
    add(
      -1,
      { op: 'launch' },
      'pass',
      'a fresh Home: on the sim this job carries on from the one before',
    );

  // A find: the runner's points in order, the first match wins; a miss names what it saw.
  const find = async (w: Where & { label: string; role?: string }) => {
    const pts = simPoints(w);
    const seen: string[] = [];
    for (let k = 0; k < pts.length; k++) {
      const el = await page.read(pts[k]!);
      if (matches(el, w.label, w.role)) {
        // A hit within the calibration's error of the frame's top or bottom is as fragile as a near miss. (A point
        // outside the frame hit it through its <label>, whose own edges the read doesn't report.)
        const p = pts[k]!;
        const edge = Math.min(p.y - el!.frame.y, el!.frame.y + el!.frame.h - p.y);
        const fragile =
          edge >= 0 && edge < NEAR_MISS_PT ? `only ${edge} pt inside the element's edge` : '';
        return { ok: true as const, el: el!, at: p, pts, k, fragile, nudged: false };
      }
      const s = seenAs(el);
      if (!seen.includes(s)) seen.push(s);
    }
    // Not on the runner's points, but within the calibration's error of one: a probe a few points of layout decide.
    for (const p of pts)
      for (const [dx, dy] of NUDGES) {
        const el = await page.read({ x: p.x + dx, y: p.y + dy });
        if (matches(el, w.label, w.role))
          return {
            ok: true as const,
            el: el!,
            at: { x: p.x + dx, y: p.y + dy },
            pts,
            k: pts.indexOf(p),
            fragile: `only ${Math.abs(dx || dy)} pt off the runner's point (${p.x},${p.y})`,
            nudged: true,
          };
      }
    return {
      ok: false as const,
      miss: `no "${w.label}" found (saw: ${seen.slice(0, 3).join(', ')})`,
    };
  };
  // Other controls a read-back could land on. While the dock settles, the find can take a point a step above or
  // below the settled hit (2026-11-12: y 450 with the dock ~30 pt high, and `keys … in` then read the private pill
  // there), so those points — and each within the calibration's error of them, vertically — must be clear.
  const strays = async (w: Where & { label: string; role?: string }, pts: Pt[], k: number) => {
    const out: string[] = [];
    for (const p of neighbours(w, pts, k))
      for (const dy of [0, ...SETTLE_NUDGES]) {
        const el = await page.read({ x: p.x, y: p.y + dy });
        if (!isControl(el) || matches(el, w.label, w.role)) continue;
        out.push(`(${p.x},${p.y}) ${dy ? `is ${Math.abs(dy)} pt from` : 'reads'} ${seenAs(el)}`);
        break;
      }
    return out;
  };

  for (const [i, op] of job.steps.entries()) {
    if (failed) {
      add(i, op, 'skip', 'after the failure above');
      continue;
    }
    const fail = async (note: string) => {
      add(i, op, 'fail', note);
      failed = true;
      const path = o.shot?.(`${job.scenario}-${job.name}-${i}`);
      if (path) await page.shot(path);
    };
    switch (op.op) {
      case 'launch':
        await page.open();
        kbUp = pageKeyboard = false;
        add(i, op, 'pass', "a fresh Home (the Home Screen and the icon are the Simulator's)");
        break;
      case 'signIn':
        add(i, op, 'skip', SKIP.signIn);
        break;
      case 'kill':
      case 'readBuild':
      case 'expectBuild':
      case 'shutdown':
        add(i, op, 'skip', SKIP.lifecycle);
        break;
      case 'shot':
        add(i, op, 'skip', SKIP.shot);
        break;
      case 'wait':
        await page.settle();
        add(i, op, 'skip', SKIP.wait);
        break;
      case 'nav': {
        // sim_op_nav: to the top, then the tab centres on the nav row, an AXLink whose label is the tab.
        const tabHit = async (): Promise<AxEl | null> => {
          for (const x of NAV_XS) {
            const el = await page.read({ x, y: NAV_Y });
            if (el?.role === 'AXLink' && el.label.toLowerCase() === op.tab.toLowerCase()) return el;
          }
          return null;
        };
        const tap = (el: AxEl) =>
          page.click({ x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 });
        await page.scrollTop();
        const hit = await tabHit();
        if (!hit) {
          await fail(
            SWIPED_TABS.includes(op.tab)
              ? `UNMODELLED: ${op.tab} needs the nav row's swipe`
              : `MISS: no ${op.tab} tab in the nav row`,
          );
          break;
        }
        await tap(hit);
        const mark = NAV_MARKS[op.tab];
        if (!mark) {
          await page.settle();
          add(i, op, 'pass', `on ${op.tab}`);
          break;
        }
        const on = async () => {
          for (const y of mark.ys)
            if (matches(await page.read({ x: mark.x, y }), mark.label, mark.role)) return true;
          return false;
        };
        // sim_op_nav's read-back ladder, its `sleep 2`s as NAV_READS settles (F198: a lazy route under load missed
        // one 300 ms settle that sim.sh's 2 s would have waited out): a read, a late read, from the top, a re-tap.
        const within = async () => {
          for (let k = 0; k < NAV_READS; k++) {
            await page.settle();
            if (await on()) return true;
          }
          return false;
        };
        const missed = `NAV_UNCONFIRMED: no ${mark.label} (${mark.role}) at ${mark.x} × ${mark.ys.join('/')}, the ${op.tab} page's landmark sim.sh reads back`;
        let note = `on ${op.tab}`;
        if (!(await within()))
          if (await within()) note += '; the page came up late';
          else {
            await page.scrollTop();
            if (await on()) note += '; its landmark showed once the page was scrolled to the top';
            else {
              const again = await tabHit();
              if (!again) {
                await fail(`${missed}; the tab wasn't there to tap again`);
                break;
              }
              await tap(again);
              if (!(await within())) {
                await fail(`${missed}; tapped twice`);
                break;
              }
              note = `on ${op.tab}; tapped again (the page wasn't ${op.tab} after the first tap)`;
            }
          }
        add(i, op, 'pass', note);
        break;
      }
      case 'scroll':
        await page.scroll(op.dir === 'down' ? op.pt : -op.pt);
        add(i, op, 'pass', `scrolled ${op.dir} ${op.pt}`);
        break;
      case 'find':
      case 'tap':
      case 'absent': {
        const d = devData(op.label);
        if (d) {
          if ('as' in op && op.as) skipped.set(op.as, `${SKIP.devData}: ${d.why}`);
          add(i, op, 'skip', `${SKIP.devData}: ${d.why}`);
          break;
        }
        if (op.op === 'absent' && pageKeyboard) {
          add(i, op, 'skip', SKIP.pageKeyboard);
          break;
        }
        const r = await find(op);
        if (op.op === 'absent') {
          // Only a near miss softens an absent: a hit on the runner's own point is what the Simulator reads too.
          if (r.ok && !r.nudged) await fail(`PRESENT: ${seenAs(r.el)} at (${r.at.x},${r.at.y})`);
          else if (r.ok)
            add(
              i,
              op,
              'warn',
              `FRAGILE: ${seenAs(r.el)} ${r.fragile} — the Simulator might see it`,
            );
          else add(i, op, 'pass', 'nothing matching there');
          break;
        }
        if (!r.ok) {
          await fail(`MISS: ${r.miss}`);
          break;
        }
        const { el, at, pts, k } = r;
        const f = el.frame;
        const where = `${el.role} at ${f.x},${f.y} ${f.w}x${f.h} (read at ${at.x},${at.y})`;
        // Fragile: the runner might hit or miss it on a few points of layout. Carried on from where it lies.
        let warn = r.fragile
          ? ` · FRAGILE: ${r.fragile} — aim the probe at the element's middle`
          : '';
        if (op.as) {
          const s = await strays(op, pts, k);
          if (s.length && readBack.has(op.as)) {
            await fail(
              `AMBIGUOUS: found ${where}, but ${s.join('; ')} — a read-back of "${op.as}" after the layout settles a step away lands there`,
            );
            break;
          }
          if (s.length) warn += ` · near: ${s.join('; ')}`;
          found.set(op.as, { el, at, modelled: !pageKeyboard, kbUp });
        }
        if (op.op === 'tap') {
          if (denied(el.label)) {
            await fail(`DENIED: the match is a write button ("${el.label}"); not tapped`);
            break;
          }
          const c = { x: Math.floor(f.x + f.w / 2), y: Math.floor(f.y + f.h / 2) };
          if (f.w <= 0 || f.h <= 0 || c.x < 0 || c.x > SIM_W || c.y < 0 || c.y > SIM_H) {
            await fail(
              `OFF_SCREEN: target centre ${c.x},${c.y} is off the ${SIM_W}x${SIM_H} screen`,
            );
            break;
          }
          await page.click(c);
          await page.settle();
          if (el.role === 'AXTextArea' || el.role === 'AXTextField') {
            kbUp = await page.focusInFixedLayer();
            pageKeyboard = !kbUp;
            await page.keyboard(kbUp);
            await page.settle();
          }
          if (op.closes) {
            const after = await page.read(c);
            if (matches(after, op.label, op.role)) {
              await fail(`STILL_THERE: ${seenAs(after)} at the tapped spot`);
              break;
            }
          }
        }
        add(
          i,
          op,
          warn ? 'warn' : 'pass',
          `${op.op === 'tap' ? 'tapped ' : ''}${where}${warn}${kbUp ? ' · keyboard model up' : ''}`,
        );
        break;
      }
      case 'expect': {
        if ('signedIn' in op) {
          add(i, op, 'skip', SKIP.signIn);
          break;
        }
        const why = skipped.get(op.as);
        if (why) {
          add(i, op, 'skip', why);
          break;
        }
        if ('aboveKeyboard' in op) {
          add(i, op, 'skip', SKIP.aboveKeyboard);
          break;
        }
        if ('sameWidthAs' in op) {
          add(i, op, 'skip', SKIP.sameWidth);
          break;
        }
        const rec = found.get(op.as);
        if (!rec) {
          await fail(`UNMODELLED: "${op.as}" was never found`);
          break;
        }
        // sim_op_expect: re-read at the found point; an empty read is enabled, with no label or value (sim_point).
        const now = await page.read(rec.at);
        const got = now ?? {
          role: '',
          label: '',
          value: '',
          enabled: true,
          frame: { x: 0, y: 0, w: 0, h: 0 },
        };
        if ('valueIs' in op && got.value !== op.valueIs)
          await fail(`VALUE: ${op.as} reads "${got.value}", expected "${op.valueIs}"`);
        else if ('labelIs' in op && got.label !== op.labelIs)
          await fail(`LABEL: ${op.as} reads "${got.label}", expected "${op.labelIs}"`);
        else if ('enabled' in op && got.enabled !== op.enabled)
          await fail(`ENABLED: ${op.as} enabled ${got.enabled}, expected ${op.enabled}`);
        else add(i, op, 'pass', `${op.as} as expected`);
        found.set(op.as, {
          el: got,
          at: rec.at,
          modelled: rec.modelled !== false && !pageKeyboard,
          kbUp,
        }); // sim_op_expect stores the re-read under the same name
        break;
      }
      case 'keys':
      case 'erase': {
        if (op.op === 'keys') await page.type(op.text);
        else await page.backspace(op.n);
        await page.settle();
        if (!op.in) {
          add(i, op, 'pass', op.op === 'keys' ? `typed ${op.text.length} keys` : `erased ${op.n}`);
          break;
        }
        // sim_typed_read / sim_erased_read: at the found point, then a second look at the frame's centre.
        const rec = found.get(op.in)!;
        const fr = rec.el.frame;
        const centre = { x: Math.floor(fr.x + fr.w / 2), y: Math.floor(fr.y + fr.h / 2) };
        const isField = (e: AxEl | null): e is AxEl =>
          !!e &&
          e.role === rec.el.role &&
          (!rec.el.label || e.label.toLowerCase() === rec.el.label.toLowerCase());
        const holds = (e: AxEl | null) =>
          op.op === 'keys'
            ? !!e && e.value.toLowerCase() === op.text
            : isField(e) && (e.value === '' || e.value === rec.el.value);
        const first = await page.read(rec.at);
        const now = holds(first) ? first : await page.read(centre);
        const where = `${op.in} read back at (${rec.at.x},${rec.at.y})`;
        if (holds(now)) add(i, op, 'pass', where);
        else if (op.op === 'erase' && !isField(first) && !isField(now))
          await fail(`MISS: ${op.in} is at neither its point nor its frame's centre (it moved)`);
        else
          await fail(
            `${op.op === 'keys' ? 'TYPED' : 'ERASED'}: ${where} is ${seenAs(now)}${now ? ` "${now.value}"` : ''}`,
          );
        break;
      }
      case 'blur':
        await page.blur();
        kbUp = pageKeyboard = false;
        await page.keyboard(false);
        await page.settle();
        add(i, op, 'pass', 'keyboard model down');
        break;
      default:
        await fail(`UNMODELLED: no model for op "${(op as { op: string }).op}"`);
    }
  }
  return {
    scenario: job.scenario,
    name: job.name,
    ops,
    ok: !failed,
    found: Object.fromEntries(
      [...found].map(([k, v]) => [
        k,
        { role: v.el.role, frame: v.el.frame, modelled: v.modelled !== false, kbUp: !!v.kbUp },
      ]),
    ),
  };
}

// Entries of DEV_DATA that no recorded op matches — a declaration that outlived its op.
export function staleDevData(jobs: { scenario: string; steps: IosOp[] }[]): string[] {
  return DEV_DATA.filter(
    (d) =>
      !jobs.some(
        (j) =>
          j.scenario === d.scenario && j.steps.some((s) => 'label' in s && s.label === d.label),
      ),
  ).map((d) => `${d.scenario}: "${d.label}"`);
}

export function formatJob(r: JobResult, header: string): string {
  const n = (s: Status) => r.ops.filter((o) => o.status === s).length;
  const lines = r.ops.map(
    (o) =>
      `  ${o.i < 0 ? '  ' : `#${String(o.i).padEnd(2)}`} ${o.op.padEnd(44)} ${o.status.padEnd(4)}  ${o.note}`,
  );
  return [
    `${r.ok ? 'PASS' : 'FAIL'} ${r.scenario}/${r.name} (${header})`,
    ...lines,
    `  pass ${n('pass')} · warn ${n('warn')} · skip ${n('skip')} · fail ${n('fail')}`,
  ].join('\n');
}
