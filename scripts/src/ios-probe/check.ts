// The probe check (IOS-CHECK.md → Probe check): an iOS plan's ops replayed against the app in a headless engine, so
// a UI change that moves a probed element off its point — or puts another control on it — fails before a Simulator
// run. It mirrors the runner's reads (points.ts, ax.ts); what only an iPhone does is skipped with a reason, never
// silently. A first filter: the Simulator stays the proof.
import type { IosOp } from '../mailroom/sim';
import { isControl, matches, seenAs, type AxEl } from './ax';
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
} as const;
export type SkipReason = keyof typeof SKIP;

// Ops that need data only dev has, by scenario and label. An entry that matches no op fails the run (a stale skip).
export const DEV_DATA: { scenario: string; label: string; why: string }[] = [
  {
    scenario: 'category-suggest',
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
}

interface Found {
  el: AxEl;
  at: Pt;
  readAt: number;
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
  let failed = false;
  let skipRest = '';

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
      if (matches(el, w.label, w.role)) return { ok: true as const, el: el!, at: pts[k]!, pts, k };
      const s = seenAs(el);
      if (!seen.includes(s)) seen.push(s);
    }
    // Not on the runner's points, but within the calibration's error of one: a probe a few points of layout decide.
    for (const p of pts)
      for (const [dx, dy] of NUDGES) {
        const el = await page.read({ x: p.x + dx, y: p.y + dy });
        if (matches(el, w.label, w.role))
          return {
            ok: false as const,
            fragile: `${seenAs(el)} only ${Math.abs(dx || dy)} pt off (${p.x},${p.y})`,
            miss: '',
          };
      }
    return {
      ok: false as const,
      fragile: '',
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
    if (failed || skipRest) {
      add(i, op, 'skip', skipRest || 'after the failure above');
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
        kbUp = false;
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
        await page.scrollTop();
        let hit: AxEl | null = null;
        for (let x = 10; x <= 430 && !hit; x += 15) {
          const el = await page.read({ x, y: 168 });
          if (el?.role === 'AXLink' && matches(el, op.tab)) hit = el;
        }
        if (!hit) {
          await fail(`no ${op.tab} link on the nav row (y 168)`);
          break;
        }
        await page.click({ x: hit.frame.x + hit.frame.w / 2, y: hit.frame.y + hit.frame.h / 2 });
        await page.settle();
        add(i, op, 'pass', `on ${op.tab}`);
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
        const r = await find(op);
        if (op.op === 'absent') {
          if (r.ok) await fail(`PRESENT: ${seenAs(r.el)} at (${r.at.x},${r.at.y})`);
          else if (r.fragile)
            add(i, op, 'warn', `FRAGILE: ${r.fragile} — the Simulator might see it`);
          else add(i, op, 'pass', 'nothing matching there');
          break;
        }
        if (!r.ok && r.fragile) {
          // The runner would hit or miss on a few points of layout; later ops build on the hit, so stop here.
          add(
            i,
            op,
            'warn',
            `FRAGILE: ${r.fragile} — widen the probe or aim it at the element's middle`,
          );
          skipRest = 'after the fragile probe above';
          break;
        }
        if (!r.ok) {
          await fail(`MISS: ${r.miss}`);
          break;
        }
        const { el, at, pts, k } = r;
        const f = el.frame;
        const where = `${el.role} at ${f.x},${f.y} ${f.w}x${f.h} (read at ${at.x},${at.y})`;
        let warn = '';
        if (op.as) {
          const s = await strays(op, pts, k);
          if (s.length && readBack.has(op.as)) {
            await fail(
              `AMBIGUOUS: found ${where}, but ${s.join('; ')} — a read-back of "${op.as}" after the layout settles a step away lands there`,
            );
            break;
          }
          if (s.length) warn = ` · near: ${s.join('; ')}`;
          found.set(op.as, { el, at, readAt: i });
        }
        if (op.op === 'tap') {
          const c = { x: Math.floor(f.x + f.w / 2), y: Math.floor(f.y + f.h / 2) };
          await page.click(c);
          await page.settle();
          if (el.role === 'AXTextArea' || el.role === 'AXTextField') {
            kbUp = await page.focusInFixedLayer();
            await page.keyboard(kbUp);
            await page.settle();
          }
          if (op.closes) {
            const after = await page.read(c);
            if (after && after.role === el.role && after.label === el.label) {
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
        const now = await page.read(rec.at);
        const got = now ?? { role: '', label: '', value: '', enabled: false, frame: rec.el.frame };
        if ('valueIs' in op && got.value !== op.valueIs)
          await fail(`VALUE: ${op.as} reads "${got.value}", expected "${op.valueIs}"`);
        else if ('labelIs' in op && got.label.toLowerCase() !== op.labelIs.toLowerCase())
          await fail(`LABEL: ${op.as} reads "${got.label}", expected "${op.labelIs}"`);
        else if ('enabled' in op && got.enabled !== op.enabled)
          await fail(`ENABLED: ${op.as} enabled ${got.enabled}, expected ${op.enabled}`);
        else add(i, op, 'pass', `${op.as} as expected`);
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
        const rec = found.get(op.in)!;
        const now = await page.read(rec.at);
        const same = !!now && now.role === rec.el.role && now.label === rec.el.label;
        const ok =
          op.op === 'keys'
            ? same && now.value.toLowerCase().includes(op.text)
            : same && (now.value === '' || now.value === rec.el.value);
        if (ok) add(i, op, 'pass', `${op.in} read back at (${rec.at.x},${rec.at.y})`);
        else
          await fail(
            `${op.op === 'keys' ? 'TYPED' : 'ERASED'}: ${op.in} read back at (${rec.at.x},${rec.at.y}) is ${seenAs(now)}${now ? ` "${now.value}"` : ''}`,
          );
        break;
      }
      case 'blur':
        await page.blur();
        kbUp = false;
        await page.keyboard(false);
        await page.settle();
        add(i, op, 'pass', 'keyboard model down');
        break;
      default:
        await fail(`UNMODELLED: no model for op "${(op as { op: string }).op}"`);
    }
  }
  return { scenario: job.scenario, name: job.name, ops, ok: !failed };
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
