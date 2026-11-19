import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { IosOp } from '../mailroom/sim';
import type { AxEl, Frame } from './ax';
import {
  checkJob,
  DEV_DATA,
  NAV_MARKS,
  NAV_READS,
  NAV_XS,
  NAV_Y,
  SKIP,
  staleDevData,
  type ProbePage,
} from './check';
import type { Pt } from './points';

// A static page: elements by frame, the last one listed on top. Typing goes into the field last clicked.
function fakePage(els: (Omit<AxEl, 'enabled'> & { enabled?: boolean })[], fixedLayer = true) {
  const layout = els.map((e) => ({ enabled: true, ...e }));
  let focus: (typeof layout)[number] | null = null;
  const inside = (f: Frame, p: Pt) =>
    p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h;
  const page: ProbePage & {
    calls: string[];
    move: (label: string, dy: number) => void;
    drop: (label: string) => void;
    add: (el: Omit<AxEl, 'enabled'>) => void;
  } = {
    calls: [],
    add: (el) => void layout.push({ enabled: true, ...el, frame: { ...el.frame } }),
    move: (label, dy) => layout.filter((x) => x.label === label).forEach((x) => (x.frame.y += dy)),
    drop: (label) => {
      const at = layout.findIndex((x) => x.label === label);
      if (at < 0) throw new Error(`no ${label} to drop`);
      layout.splice(at, 1);
    },
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
    focusInFixedLayer: async () => fixedLayer,
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

  it('warns FRAGILE when a match lies only within the calibration error of a point, and carries on from it', async () => {
    const r = await checkJob(
      DOCK(),
      job([
        { op: 'find', label: 'Save log', scan: { x: 395, from: 420, to: 480 }, as: 'send' },
        { op: 'expect', as: 'send', enabled: true },
      ]),
    );
    expect(r.ops[1]).toMatchObject({ status: 'warn' });
    expect(r.ops[1]!.note).toContain("FRAGILE: only 8 pt off the runner's point (395,480)");
    expect(r.ops[2]).toMatchObject({ status: 'pass', note: 'send as expected' });
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

// The runner's own semantics (tools/mailroom/jobs/sim.sh), where the check must neither pass nor fail differently.
describe('checkJob mirrors sim.sh', () => {
  const tapBar: IosOp = { op: 'tap', label: 'Capture', near: { x: 200, y: 500 }, radius: 10 };
  const bar300 = findBar(300);

  it('keys … in needs the field to hold exactly the typed text (sim_typed_read)', async () => {
    const page = DOCK();
    const ok = await checkJob(page, job([tapBar, bar300, { op: 'keys', text: 'zz', in: 'bar' }]));
    expect(ok.ok).toBe(true);
    const twice = await checkJob(
      DOCK(),
      job([
        tapBar,
        bar300,
        { op: 'keys', text: 'zz', in: 'bar' },
        { op: 'keys', text: 'zz', in: 'bar' },
      ]),
    );
    expect(twice.ops.at(-1)).toMatchObject({ status: 'fail' });
    expect(twice.ops.at(-1)!.note).toMatch(/^TYPED: /);
  });

  it('refuses to tap a write button the match landed on (DENIED)', async () => {
    const r = await checkJob(
      DOCK(),
      job([{ op: 'tap', label: 'Sav', near: { x: 395, y: 505 }, radius: 10 }]),
    );
    expect(r.ops[1]).toMatchObject({ status: 'fail' });
    expect(r.ops[1]!.note).toMatch(/^DENIED: /);
  });

  it('fails a tap whose target centre is off the screen (OFF_SCREEN)', async () => {
    const page = fakePage([
      { role: 'AXButton', label: 'Edge', value: '', frame: { x: 400, y: 940, w: 100, h: 40 } },
    ]);
    const r = await checkJob(
      page,
      job([{ op: 'tap', label: 'Edge', near: { x: 420, y: 950 }, radius: 10 }]),
    );
    expect(r.ops[1]!.note).toMatch(/^OFF_SCREEN: target centre 450,960/);
  });

  it('fails a closes tap when anything matching the op is still at the spot (prefix, as sim_tap_gone)', async () => {
    const page = fakePage([
      {
        role: 'AXButton',
        label: 'Cancel edit',
        value: '',
        frame: { x: 100, y: 100, w: 80, h: 40 },
      },
    ]);
    const r = await checkJob(
      page,
      job([{ op: 'tap', label: 'Cancel', near: { x: 140, y: 120 }, radius: 10, closes: true }]),
    );
    expect(r.ops[1]!.note).toMatch(/^STILL_THERE: /);
  });

  it('a selects tap must leave its toggle on; one already on is not tapped (sim_tap_selected)', async () => {
    const toggle = (value: string) => ({
      role: 'AXCheckBox',
      label: 'Task',
      value,
      frame: { x: 80, y: 850, w: 60, h: 40 },
    });
    const tap: IosOp = {
      op: 'tap',
      label: 'Task',
      scan: { x: 110, from: 780, to: 940 },
      role: 'AXCheckBox',
      selects: true,
    };
    const dropped = await checkJob(fakePage([toggle('0')]), job([tap]));
    expect(dropped.ops[1]!.note).toMatch(/^NOT_SELECTED: Task \(AXCheckBox\) "0"/);

    const on = fakePage([toggle('0')]);
    const click = on.click;
    on.click = async (p) => {
      await click(p);
      on.drop('Task');
      on.add(toggle('1'));
    };
    expect((await checkJob(on, job([tap]))).ops[1]).toMatchObject({ status: 'pass' });

    const gone = fakePage([toggle('0')]);
    const click2 = gone.click;
    gone.click = async (p) => {
      await click2(p);
      gone.drop('Task');
    };
    expect((await checkJob(gone, job([tap]))).ops[1]!.note).toMatch(
      /^MISS: "Task" isn't at 110,870 after the tap \(saw nothing\)/,
    );

    const already = fakePage([toggle('1')]);
    let clicks = 0;
    already.click = async () => void clicks++;
    const r = await checkJob(already, job([tap]));
    expect(r.ops[1]!.note).toMatch(/^already selected; not tapped/);
    expect(clicks).toBe(0);
  });

  it('reads an empty spot as enabled with no label, and compares labelIs exactly (sim_op_expect)', async () => {
    const page = DOCK();
    const send: IosOp = {
      op: 'find',
      label: 'Save log',
      near: { x: 395, y: 505 },
      radius: 10,
      as: 'send',
    };
    const ops = (page2: typeof page) =>
      checkJob(page2, job([send, { op: 'blur' }, { op: 'expect', as: 'send', enabled: true }]));
    // blur is where the fake drops it: a read-back over nothing
    const blur = page.blur;
    page.blur = async () => (page.drop('Save log'), blur());
    expect((await ops(page)).ops.at(-1)).toMatchObject({ status: 'pass' });
    const caseDiffers = await checkJob(
      DOCK(),
      job([findBar(300), { op: 'expect', as: 'bar', labelIs: 'capture log' }]),
    );
    expect(caseDiffers.ops.at(-1)!.note).toMatch(/^LABEL: /);
  });

  it("reads a field back at its frame's centre when its point misses (the second look)", async () => {
    const page = DOCK();
    const r = await checkJob(
      page,
      job([
        tapBar,
        { ...bar300, near: { x: 300, y: 495 }, radius: 10 } as IosOp,
        { op: 'wait', s: 1 },
        { op: 'keys', text: 'zz', in: 'bar' },
      ]),
    );
    expect(r.ok).toBe(true);
    const moved = DOCK();
    const settle = moved.settle;
    let n = 0;
    moved.settle = async () => (++n === 3 && moved.move('Capture log', 10), settle()); // after the wait: the frame starts 4 pt below the point
    const again = await checkJob(
      moved,
      job([
        tapBar,
        { ...bar300, near: { x: 300, y: 495 }, radius: 10 } as IosOp,
        { op: 'wait', s: 1 },
        { op: 'keys', text: 'zz', in: 'bar' },
      ]),
    );
    expect(again.ops.at(-1)).toMatchObject({ status: 'pass' });
  });

  it('fails an erase that leaves text (ERASED), and one whose field moved off both looks (MISS)', async () => {
    const left = await checkJob(
      DOCK(),
      job([
        tapBar,
        bar300,
        { op: 'keys', text: 'zz', in: 'bar' },
        { op: 'erase', n: 1, in: 'bar' },
      ]),
    );
    expect(left.ops.at(-1)!.note).toMatch(
      /^ERASED: bar read back at \(300,510\) is Capture log \(AXTextArea\) "z"/,
    );
    const page = DOCK();
    const settle = page.settle;
    let n = 0;
    page.settle = async () => (++n === 3 && page.move('Capture log', 200), settle());
    const gone = await checkJob(page, job([tapBar, bar300, { op: 'erase', n: 1, in: 'bar' }]));
    expect(gone.ops.at(-1)!.note).toMatch(/^MISS: bar is at neither/);
  });

  it('warns FRAGILE on a hit within the calibration error of the frame edge', async () => {
    const page = fakePage([
      { role: 'AXCheckBox', label: 'Log', value: '1', frame: { x: 28, y: 446, w: 42, h: 28 } },
    ]);
    const r = await checkJob(
      page,
      job([{ op: 'find', label: 'Log', scan: { x: 49, from: 390, to: 480 }, as: 'mode' }]),
    );
    expect(r.ops[1]).toMatchObject({ status: 'warn' });
    expect(r.ops[1]!.note).toContain("FRAGILE: only 4 pt inside the element's edge");
  });

  it("navigates by the runner's tab points and exact label", async () => {
    const BULK = {
      role: 'AXButton',
      label: 'Bulk add',
      value: '',
      frame: { x: 318, y: 212, w: 102, h: 34 },
    };
    const page = fakePage([
      { role: 'AXLink', label: 'tasks', value: '', frame: { x: 110, y: 155, w: 50, h: 26 } },
      { role: 'AXLink', label: 'Tasksmith', value: '', frame: { x: 180, y: 155, w: 60, h: 26 } },
      BULK,
    ]);
    expect((await checkJob(page, job([{ op: 'nav', tab: 'Tasks' }]))).ops[1]).toMatchObject({
      status: 'pass',
      note: 'on Tasks',
    });
    const only = fakePage([
      { role: 'AXLink', label: 'Tasksmith', value: '', frame: { x: 180, y: 155, w: 60, h: 26 } },
    ]);
    expect((await checkJob(only, job([{ op: 'nav', tab: 'Tasks' }]))).ops[1]!.note).toBe(
      'MISS: no Tasks tab in the nav row',
    );
    // the Tasks page's landmark, as sim.sh reads it back after the tap: moved, it fails here before the Simulator
    const moved = fakePage([
      { role: 'AXLink', label: 'Tasks', value: '', frame: { x: 110, y: 155, w: 50, h: 26 } },
      { ...BULK, frame: { x: 200, y: 212, w: 102, h: 34 } },
    ]);
    expect((await checkJob(moved, job([{ op: 'nav', tab: 'Tasks' }]))).ops[1]!.note).toMatch(
      /^NAV_UNCONFIRMED: no Bulk add \(AXButton\) at 369 × 232\/212\/252/,
    );
  });

  describe("nav's read-back ladder, as sim_op_nav's (F198)", () => {
    const TAB = {
      role: 'AXLink',
      label: 'Tasks',
      value: '',
      frame: { x: 110, y: 155, w: 50, h: 26 },
    };
    const BULK = {
      role: 'AXButton',
      label: 'Bulk add',
      value: '',
      frame: { x: 318, y: 212, w: 102, h: 34 },
    };
    // The landmark shows after `after` settles (counting from the first tap), only from the top if `onTop`, or only
    // after a second tap; `dropTab` takes the tab away after the first tap.
    const slow = (o: {
      after?: number;
      onTop?: boolean;
      secondTap?: boolean;
      dropTab?: boolean;
    }) => {
      const page = fakePage([TAB]);
      let settles = 0;
      let taps = 0;
      let shown = false;
      const show = () => {
        if (shown) return;
        shown = true;
        page.add(BULK);
      };
      const { click, settle, scrollTop } = page;
      page.click = async (p) => {
        await click(p);
        taps++;
        if (o.dropTab && taps === 1) page.drop('Tasks');
        if (o.secondTap && taps === 2) show();
      };
      page.settle = async () => {
        await settle();
        if (taps > 0 && ++settles === o.after) show();
      };
      page.scrollTop = async () => {
        await scrollTop();
        if (o.onTop && taps > 0) show();
      };
      return { page, taps: () => taps };
    };
    const nav = async (page: ReturnType<typeof fakePage>) =>
      (await checkJob(page, job([{ op: 'nav', tab: 'Tasks' }]))).ops[1]!;
    it('the landmark within the first window: plain "on Tasks"', async () => {
      expect(await nav(slow({ after: NAV_READS }).page)).toMatchObject({
        status: 'pass',
        note: 'on Tasks',
      });
    });
    it('within the second: "the page came up late"', async () => {
      expect((await nav(slow({ after: NAV_READS + 1 }).page)).note).toBe(
        'on Tasks; the page came up late',
      );
    });
    it('only from the top of the page: its own note', async () => {
      expect((await nav(slow({ onTop: true }).page)).note).toBe(
        'on Tasks; its landmark showed once the page was scrolled to the top',
      );
    });
    it('only after a second tap: "tapped again", and exactly two taps', async () => {
      const s = slow({ secondTap: true });
      expect((await nav(s.page)).note).toBe(
        "on Tasks; tapped again (the page wasn't Tasks after the first tap)",
      );
      expect(s.taps()).toBe(2);
    });
    it('never: NAV_UNCONFIRMED after two taps; the tab gone at the re-tap: NAV_UNCONFIRMED too', async () => {
      const never = slow({});
      expect(await nav(never.page)).toMatchObject({ status: 'fail' });
      expect((await nav(slow({}).page)).note).toMatch(/^NAV_UNCONFIRMED: .*; tapped twice$/);
      expect(never.taps()).toBe(2);
      expect((await nav(slow({ dropTab: true }).page)).note).toMatch(
        /^NAV_UNCONFIRMED: .*; the tab wasn't there to tap again$/,
      );
    });
    it("its notes are sim.sh's, word for word", () => {
      const sh = readFileSync(
        new URL('../../../tools/mailroom/jobs/sim.sh', import.meta.url),
        'utf8',
      );
      for (const n of [
        '; the page came up late',
        '; its landmark showed once the page was scrolled to the top',
        "; tapped again (the page wasn't $tab after the first tap)",
      ])
        expect(sh).toContain(n);
    });
  });

  it("models sim.sh's nav landmarks exactly (sim_nav_mark)", () => {
    const sh = readFileSync(
      new URL('../../../tools/mailroom/jobs/sim.sh', import.meta.url),
      'utf8',
    );
    const line = sh.match(/^sim_nav_mark\(\) \{ case "\$1" in (.*) esac; \}$/m)?.[1] ?? '';
    const marks = [...line.matchAll(/(\w+)\) echo "([^|]+)\|(\w+)\|(\d+)\|([\d ]+)" ;;/g)].map(
      (m) => [
        m[1],
        { label: m[2], role: m[3], x: Number(m[4]), ys: (m[5] ?? '').split(' ').map(Number) },
      ],
    );
    expect(Object.fromEntries(marks)).toEqual(NAV_MARKS);
  });

  it("skips an absent while a page field's keyboard is up, rather than passing on an unmodelled layout", async () => {
    const pageField = fakePage(
      [
        {
          role: 'AXTextField',
          label: 'Search tasks',
          value: 'Search…',
          frame: { x: 20, y: 308, w: 400, h: 42 },
        },
      ],
      false,
    );
    const ops: IosOp[] = [
      { op: 'tap', label: 'Search tasks', near: { x: 200, y: 330 }, radius: 10 },
      { op: 'absent', label: 'Capture log', near: { x: 200, y: 480 }, radius: 40 },
    ];
    expect((await checkJob(pageField, job(ops))).ops[2]).toMatchObject({
      status: 'skip',
      note: SKIP.pageKeyboard,
    });
  });

  it("uses the runner's nav row points (SIM_XS_NAV, SIM_Y_NAV), and fails a swiped tab as unmodelled", async () => {
    const sh = readFileSync(
      new URL('../../../tools/mailroom/jobs/sim.sh', import.meta.url),
      'utf8',
    );
    const xs = /^SIM_XS_NAV="([^"]+)"/m.exec(sh)![1]!.split(' ').map(Number);
    expect(xs).toEqual(NAV_XS);
    expect(Number(/^SIM_Y_NAV=(\d+)/m.exec(sh)![1])).toBe(NAV_Y);
    const r = await checkJob(DOCK(), job([{ op: 'nav', tab: 'Settings' }]));
    expect(r.ops[1]!.note).toBe("UNMODELLED: Settings needs the nav row's swipe");
  });

  it('fails an absent that hits on its own point even near the edge (only a near miss softens it)', async () => {
    const r = await checkJob(
      DOCK(),
      job([{ op: 'absent', label: 'Capture log', near: { x: 200, y: 493 }, radius: 10 }]),
    );
    expect(r.ops[1]!.note).toMatch(/^PRESENT: Capture log \(AXTextArea\) at \(200,493\)/);
  });

  it('stores what an expect re-read, as sim_op_expect does (an empty read: no label, enabled)', async () => {
    const page = DOCK();
    const blur = page.blur;
    page.blur = async () => (page.drop('Save log'), blur());
    const r = await checkJob(
      page,
      job([
        { op: 'find', label: 'Save log', near: { x: 395, y: 505 }, radius: 10, as: 'send' },
        { op: 'blur' },
        { op: 'expect', as: 'send', labelIs: '' },
        { op: 'expect', as: 'send', enabled: true },
      ]),
    );
    expect(r.ops.slice(-2).map((o) => o.status)).toEqual(['pass', 'pass']);
  });
});
