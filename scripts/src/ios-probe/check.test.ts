import { describe, expect, it } from 'vitest';
import type { IosOp } from '../mailroom/sim';
import type { AxEl, Frame } from './ax';
import { checkJob, DEV_DATA, SKIP, staleDevData, type ProbePage } from './check';
import type { Pt } from './points';

// A static page: elements by frame, the last one listed on top. Typing goes into the field last clicked.
function fakePage(els: (Omit<AxEl, 'enabled'> & { enabled?: boolean })[]) {
  const layout = els.map((e) => ({ enabled: true, ...e }));
  let focus: (typeof layout)[number] | null = null;
  const inside = (f: Frame, p: Pt) =>
    p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h;
  const page: ProbePage & { calls: string[] } = {
    calls: [],
    open: async () => void page.calls.push('open'),
    read: async (p) => {
      const e = layout.findLast((x) => inside(x.frame, p));
      return e ? { ...e, frame: { ...e.frame } } : null;
    },
    click: async (p) => {
      focus = layout.findLast((x) => inside(x.frame, p)) ?? null;
    },
    type: async (t) => {
      if (focus) focus.value = (focus.value === 'What happened?' ? '' : focus.value) + t;
    },
    backspace: async (n) => {
      if (focus) focus.value = focus.value.slice(0, -n) || 'What happened?';
    },
    blur: async () => void (focus = null),
    scrollTop: async () => {},
    scroll: async () => {},
    focusInFixedLayer: async () => true,
    keyboard: async (up) => void page.calls.push(`keyboard ${up}`),
    settle: async () => {},
    shot: async (path) => void page.calls.push(`shot ${path}`),
  };
  return page;
}

// The keyboard-up dock as the calibration measured it (2026-11-12): the field, Log mode's private pill, Focus, Save.
const DOCK = () =>
  fakePage([
    {
      role: 'AXTextArea',
      label: 'Capture log',
      value: 'What happened?',
      frame: { x: 25, y: 489, w: 346, h: 36 },
    },
    { role: 'AXCheckBox', label: 'private', value: '0', frame: { x: 179, y: 451, w: 71, h: 26 } },
    { role: 'AXButton', label: 'Focus', value: '', frame: { x: 343, y: 451, w: 70, h: 28 } },
    { role: 'AXButton', label: 'Save log', value: '', frame: { x: 379, y: 487, w: 36, h: 36 } },
    { role: 'AXStaticText', label: '', value: 'Thursday', frame: { x: 20, y: 300, w: 100, h: 20 } },
  ]);
const job = (steps: IosOp[], scenario = 'demo') => ({ scenario, name: 'job', steps });
const findBar = (x: number): IosOp => ({
  op: 'find',
  label: 'Capture log',
  near: { x, y: 480 },
  radius: 40,
  role: 'AXTextArea',
  as: 'bar',
});

describe('checkJob', () => {
  it('fails AMBIGUOUS where a read-back point sits by another control — the private pill (pre-151 probe)', async () => {
    const r = await checkJob(DOCK(), job([findBar(200), { op: 'keys', text: 'zz', in: 'bar' }]));
    expect(r.ok).toBe(false);
    const f = r.ops.find((o) => o.status === 'fail')!;
    expect(f.note).toMatch(/^AMBIGUOUS: .*\(200,480\) is 4 pt from private \(AXCheckBox\)/);
    expect(r.ops.at(-1)).toMatchObject({ status: 'skip', note: 'after the failure above' });
  });

  it('passes the probe moved clear of the pill (x 300) and reads the typed text back', async () => {
    const r = await checkJob(
      DOCK(),
      job([
        { op: 'launch' },
        { op: 'tap', label: 'Capture', near: { x: 200, y: 500 }, radius: 10 },
        findBar(300),
        { op: 'keys', text: 'zz', in: 'bar' },
        { op: 'erase', n: 2, in: 'bar' },
        { op: 'expect', as: 'bar', valueIs: 'What happened?' },
      ]),
    );
    expect(r.ops.map((o) => o.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(r.ok).toBe(true);
  });

  it('only warns when the neighbour is near a probe whose point nothing reads back', async () => {
    const r = await checkJob(
      DOCK(),
      job([findBar(200), { op: 'expect', as: 'bar', enabled: true }]),
    );
    expect(r.ok).toBe(true);
    expect(r.ops[1]).toMatchObject({ status: 'warn' });
    expect(r.ops[1]!.note).toContain('private (AXCheckBox)');
  });

  it('fails MISS naming what the points saw, with a screenshot when asked', async () => {
    const page = DOCK();
    const r = await checkJob(
      page,
      job([{ op: 'find', label: 'Capture log', near: { x: 60, y: 300 }, radius: 10, as: 'x' }]),
      { shot: (n) => `/tmp/${n}.png` },
    );
    expect(r.ops[1]).toMatchObject({ status: 'fail' });
    expect(r.ops[1]!.note).toBe('MISS: no "Capture log" found (saw: Thursday (AXStaticText))');
    expect(page.calls).toContain('shot /tmp/demo-job-0.png');
  });

  it('warns FRAGILE when a match lies only within the calibration error of a point, and stops there', async () => {
    const r = await checkJob(
      DOCK(),
      job([
        { op: 'find', label: 'Save log', scan: { x: 395, from: 420, to: 480 }, as: 'send' },
        { op: 'expect', as: 'send', enabled: true },
      ]),
    );
    expect(r.ops[1]).toMatchObject({ status: 'warn' });
    expect(r.ops[1]!.note).toMatch(/^FRAGILE: Save log \(AXButton\) only 8 pt off \(395,480\)/);
    expect(r.ops[2]).toMatchObject({ status: 'skip', note: 'after the fragile probe above' });
    expect(r.ok).toBe(true);
  });

  it('fails an absent that hits, passes one that misses', async () => {
    const op = (y: number): IosOp => ({
      op: 'absent',
      label: 'Capture log',
      near: { x: 200, y },
      radius: 10,
    });
    expect((await checkJob(DOCK(), job([op(500)]))).ops[1]).toMatchObject({ status: 'fail' });
    expect((await checkJob(DOCK(), job([op(700)]))).ops[1]).toMatchObject({ status: 'pass' });
  });

  it('turns the keyboard model on for a tapped field and off at blur', async () => {
    const page = DOCK();
    await checkJob(
      page,
      job([{ op: 'tap', label: 'Capture', near: { x: 200, y: 500 }, radius: 10 }, { op: 'blur' }]),
    );
    expect(page.calls).toEqual(['open', 'keyboard true', 'keyboard false']);
  });

  it('skips what only the Simulator does, each with a reason from SKIP', async () => {
    const r = await checkJob(
      DOCK(),
      job([
        { op: 'launch' },
        { op: 'signIn' },
        { op: 'expect', signedIn: true },
        { op: 'readBuild' },
        { op: 'expectBuild' },
        { op: 'kill', method: 'terminate' },
        { op: 'launch' },
        { op: 'wait', s: 2 },
        findBar(300),
        { op: 'expect', as: 'bar', aboveKeyboard: true },
        { op: 'expect', as: 'bar', sameWidthAs: 'bar' },
        { op: 'shot', name: 'x' },
        { op: 'shutdown' },
      ]),
    );
    const reasons = Object.values(SKIP) as string[];
    const skips = r.ops.filter((o) => o.status === 'skip');
    expect(skips).toHaveLength(10);
    for (const s of skips) expect(reasons, s.note).toContain(s.note);
  });

  it('skips a declared dev-data op and everything that reads its result, with the why', async () => {
    const d = DEV_DATA[0]!;
    const r = await checkJob(
      DOCK(),
      job(
        [
          { op: 'find', label: d.label, scan: { x: 195, from: 300, to: 600 }, as: 'chip' },
          { op: 'expect', as: 'chip', enabled: true },
        ],
        d.scenario,
      ),
    );
    expect(r.ops.slice(1).map((o) => o.status)).toEqual(['skip', 'skip']);
    expect(r.ops[2]!.note).toBe(`${SKIP.devData}: ${d.why}`);
  });

  it('fails an op it has no model for, rather than skipping it', async () => {
    const r = await checkJob(DOCK(), job([{ op: 'teleport' } as unknown as IosOp]));
    expect(r.ops[1]).toMatchObject({
      status: 'fail',
      note: 'UNMODELLED: no model for op "teleport"',
    });
  });
});

describe('staleDevData', () => {
  it('names a declared dev-data skip no recorded op matches', () => {
    const d = DEV_DATA[0]!;
    expect(
      staleDevData([
        { scenario: d.scenario, steps: [{ op: 'absent', label: d.label, near: { x: 1, y: 1 } }] },
      ]),
    ).toEqual([]);
    expect(staleDevData([])).toEqual([`${d.scenario}: "${d.label}"`]);
  });
});
