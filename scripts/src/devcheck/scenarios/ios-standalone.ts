// The Home Screen web app on the Mac's iOS Simulator (docs/ops/IOS-CHECK.md): it launches signed in, survives
// three kinds of kill, picks up a deploy by its second launch, and keeps the capture bar and the Done form's
// Reflection box above the soft keyboard without zooming. Every step is slow (a sim run is minutes), so a full
// run defers them unless the branch touches what they can see (APP, below) or names this scenario (DEV-CHECK.md → Slow tier).
// The sim never submits: the one task it opens is set up here through MCP, and the sim only focuses, types a
// draft by key taps and erases it — capture-long also seeds 16 API tasks (ledgered) and taps Review, a real parse
// that saves nothing. Coordinates are points on the iPhone 18 Pro Max (440×956), from the 2026-11-05
// re-measure (keyboard up, the capture bar sits at y 462); a MISS after an app change means a plan needs new ones —
// read the step's screenshot.
import { datesFor, needsYou, type Ctx, type Scenario } from '../scenario';
import { IosAssert, type IosOp, type SimResult } from '../../mailroom/sim';

// One keyboard layer only (`keys` takes ^[a-z ]+$): the nonce with its digits as letters. Six: the run's time of day
// (the nonce's tail is the tier), and each typed key is a tap that can drop.
const marker = (ctx: Ctx) =>
  ctx.nonce
    .toLowerCase()
    .replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a')
    .replace(/[^a-z]/g, '')
    .slice(0, 6);
const title = (ctx: Ctx) => `devcheck-ios ${marker(ctx)}`;
let taskId = '';
let drove = false; // the sim got through the Done form, so "untouched" means something
// Four typed keys, two spare deletes: a delete tap can drop silently (job …043145Z…-capture-d571 left a Z), and one on an
// empty field does nothing. Typed keys are read back (`keys … in`) and retyped (job …083234Z…-capture-5c12 lost one);
// the field is read back after the deletes too (`erase … in`: …230610Z…-done-form-4385 left a Z after six), and the
// note counts any extra round, so how often deletes drop stays visible.
const ERASE = 6;

const LAUNCH: IosOp[] = [
  { op: 'launch' },
  { op: 'signIn' },
  { op: 'expect', signedIn: true },
  { op: 'readBuild' },
  { op: 'expectBuild' }, // a stale first launch gets one relaunch: the two-launch refresh
  { op: 'shot', name: 'home' },
];

const CAPTURE: IosOp[] = [
  { op: 'nav', tab: 'Home' },
  {
    op: 'find',
    label: 'Capture log',
    near: { x: 220, y: 895 },
    radius: 10,
    role: 'AXTextArea',
    as: 'bar0',
  },
  { op: 'tap', label: 'Capture', near: { x: 220, y: 895 }, radius: 10 },
  { op: 'wait', s: 2 },
  {
    op: 'find',
    label: 'Capture log',
    near: { x: 200, y: 480 },
    radius: 40,
    role: 'AXTextArea',
    as: 'bar',
  },
  { op: 'expect', as: 'bar', aboveKeyboard: true },
  { op: 'expect', as: 'bar', sameWidthAs: 'bar0' },
  { op: 'find', label: 'Log', near: { x: 49, y: 437 }, radius: 40, role: 'AXCheckBox', as: 'mode' },
  { op: 'expect', as: 'mode', aboveKeyboard: true },
  { op: 'shot', name: 'capture-keyboard' },
  { op: 'keys', text: 'zzqx', in: 'bar' },
  { op: 'find', label: 'zzqx', near: { x: 60, y: 480 }, radius: 40, as: 'typed' },
  {
    op: 'find',
    label: 'Save log',
    near: { x: 395, y: 480 },
    radius: 40,
    role: 'AXButton',
    as: 'send',
  },
  { op: 'expect', as: 'send', enabled: true },
  { op: 'erase', n: ERASE, in: 'bar' },
  { op: 'expect', as: 'bar', valueIs: 'What happened?' },
  { op: 'expect', as: 'send', enabled: false },
  { op: 'blur' },
];

// A long page, scrolled, then the capture bar in Task mode and a Review: on PR 118's run (2026-11-07) the dock sat
// ~56 pt low there, its preview row on the keyboard's accessory bar, and `aboveKeyboard` still passed; on 2026-11-08 it
// was low again in 1 of 5 runs (job …215853Z…-ce3e: the field at y 530, not 462, right after focus). So the field is
// measured at focus, after the Task switch and after the Review, and the preview row last — each must clear the bar
// by CLEARANCE, read from the expect's note. Tasks' Today list, not Home: Home's length depends on the hour. The
// Review parses (real Haiku on dev) and saves nothing; the field is erased and the mode put back to Log.
const LONG_PAD = 16;
const CLEARANCE = 30;
// The field's clearance after the Review is ~88 pt on a good run (58 at focus, plus the preview row it sits above).
// Under this, a preview row missing under the bar is the low dock, not a broken Review.
const FIELD_OVER_PREVIEW = 60;
// The page is what must be long, not the line: six keys at most, like every other typed draft here — each key is a
// tap that can drop, and a retype's deletes each cost a point read (job …211837Z…-0239 timed out retyping 20). One
// word, so the parse's preview title starts with it (the probe matches that prefix).
const LONG_LINE = 'vacuum';
const CAPTURE_LONG: IosOp[] = [
  { op: 'nav', tab: 'Tasks' },
  { op: 'scroll', dir: 'down', pt: 400 },
  { op: 'tap', label: 'Capture', near: { x: 220, y: 895 }, radius: 10 },
  { op: 'wait', s: 2 },
  {
    op: 'find',
    label: 'Capture log',
    scan: { x: 200, from: 300, to: 650 },
    role: 'AXTextArea',
    as: 'long-bar',
  },
  // At focus, before any typing: the low dock shows here already.
  { op: 'expect', as: 'long-bar', aboveKeyboard: true },
  { op: 'tap', label: 'Task', scan: { x: 110, from: 300, to: 650 }, role: 'AXCheckBox' },
  {
    op: 'find',
    label: 'Capture task',
    scan: { x: 200, from: 300, to: 650 },
    role: 'AXTextArea',
    as: 'long-bar-task',
  },
  { op: 'expect', as: 'long-bar-task', aboveKeyboard: true },
  { op: 'keys', text: LONG_LINE, in: 'long-bar-task' },
  {
    op: 'tap',
    label: 'Review before saving',
    scan: { x: 355, from: 300, to: 650 },
    role: 'AXButton',
  },
  { op: 'wait', s: 6 },
  // A filled field reads as its value; scanned down, the field comes before the preview's copy below it.
  { op: 'find', label: LONG_LINE, scan: { x: 40, from: 300, to: 650 }, as: 'long-field' },
  { op: 'expect', as: 'long-field', aboveKeyboard: true },
  // Scanned up from the keyboard: the preview's copy of the line sits below the field's.
  {
    op: 'find',
    label: LONG_LINE,
    scan: { x: 40, from: 650, to: 300 },
    role: 'AXStaticText',
    as: 'long-preview',
  },
  { op: 'expect', as: 'long-preview', aboveKeyboard: true },
  { op: 'shot', name: 'capture-long' },
  { op: 'erase', n: LONG_LINE.length + 2 },
  { op: 'tap', label: 'Log', scan: { x: 49, from: 300, to: 650 }, role: 'AXCheckBox' },
  { op: 'blur' },
];

// The bug this row guards is still live. Until the lift fix lands, the low dock is needs-you naming it — never a fail,
// so it can't turn another branch's run red; any other failure still fails. The fix's PR makes it a fail again (it
// needs this row red without the fix).
export const LOW_DOCK_KNOWN =
  'known issue, still live: on a long page the capture dock can sit ~60 pt low, under the keyboard’s accessory bar — the closed-loop lift fix is a follow-up; until it lands this state is needs-you, not a fail';

// The low dock, from a failed job: a long-* element under the keyboard, or the preview row missing while the field
// above it sat low enough to put it under the bar. Null for anything else, which stays a failure.
function lowDock(err: unknown, plan: IosOp[]): string | null {
  const r = err instanceof Error && err.cause instanceof IosAssert ? err.cause.result : null;
  const failed = r?.steps?.find((x) => x.status === 'fail');
  if (!r || !failed) return null;
  if (r.detail === 'BELOW_KEYBOARD' && failed.note?.startsWith('long-')) return failed.note;
  const op = plan[failed.i];
  if (r.detail === 'MISS' && op?.op === 'find' && op.as === 'long-preview') {
    const field = clearanceOf(
      r.steps?.find((x) => x.op === 'expect' && x.note?.startsWith('long-field '))?.note,
    );
    if (field && field.top - field.bottom < FIELD_OVER_PREVIEW)
      return `no preview row above the bar; the field's bottom ${field.bottom} is ${field.top - field.bottom} pt above it`;
  }
  return null;
}

// "<as> bottom B vs keyboard top T" — sim.sh's aboveKeyboard note.
function clearanceOf(note: string | undefined): { bottom: number; top: number } | null {
  const m = /bottom (\d+(?:\.\d+)?) vs keyboard top (\d+(?:\.\d+)?)/.exec(note ?? '');
  return m ? { bottom: Number(m[1]), top: Number(m[2]) } : null;
}

const doneForm = (ctx: Ctx): IosOp[] => [
  { op: 'nav', tab: 'Tasks' },
  { op: 'tap', label: 'Search tasks', near: { x: 200, y: 332 }, radius: 40, role: 'AXTextField' },
  { op: 'wait', s: 1 },
  // a page field: the dock must not lift over it (re-found: the page may have scrolled it)
  {
    op: 'find',
    label: 'Search tasks',
    scan: { x: 200, from: 120, to: 540 },
    role: 'AXTextField',
    as: 'search',
  },
  { op: 'expect', as: 'search', aboveKeyboard: true },
  // …and the capture dock didn't lift over the page: lifted, its bar would sit just above the keyboard
  { op: 'absent', label: 'Capture log', near: { x: 200, y: 480 }, radius: 40, role: 'AXTextArea' },
  { op: 'keys', text: marker(ctx), in: 'search' },
  { op: 'blur' },
  // The row's Done opens the modal with the Done form on top, as on the phone. Opening only: the form's own button submits.
  { op: 'tap', label: 'Done', scan: { x: 395, from: 390, to: 840 }, role: 'AXButton' },
  { op: 'wait', s: 2 },
  { op: 'find', label: 'Reflection', scan: { x: 200, from: 150, to: 720 }, as: 'box0' },
  { op: 'tap', label: 'Reflection', scan: { x: 200, from: 150, to: 720 } },
  { op: 'wait', s: 2 },
  { op: 'find', label: 'Reflection', scan: { x: 200, from: 120, to: 690 }, as: 'box' },
  { op: 'expect', as: 'box', aboveKeyboard: true },
  { op: 'expect', as: 'box', sameWidthAs: 'box0' },
  { op: 'shot', name: 'done-form-keyboard' },
  { op: 'blur' },
  { op: 'tap', label: 'Reflection', scan: { x: 200, from: 150, to: 720 } },
  { op: 'wait', s: 2 },
  { op: 'find', label: 'Reflection', scan: { x: 200, from: 120, to: 690 }, as: 'again' },
  { op: 'expect', as: 'again', aboveKeyboard: true },
  { op: 'keys', text: 'zzqx', in: 'again' },
  { op: 'erase', n: ERASE, in: 'again' },
  { op: 'blur' },
  // closes: still there after the tap means it dropped (…4385 left the modal over Home for the next job's launch)
  {
    op: 'tap',
    label: 'Cancel',
    scan: { x: 190, from: 150, to: 720 },
    role: 'AXButton',
    closes: true,
  },
  // and the modal is really gone: Tasks' search is found where the first tap found it, keyboard down (the modal, or
  // its discard confirm, covers that spot; `search` itself was recorded with the keyboard up, higher on the page)
  {
    op: 'find',
    label: 'Search tasks',
    near: { x: 200, y: 332 },
    radius: 40,
    role: 'AXTextField',
    as: 'closed',
  },
  { op: 'shot', name: 'done-form-closed' },
];

const RELAUNCH: IosOp[] = [
  { op: 'kill', method: 'terminate' },
  { op: 'launch' },
  { op: 'expect', signedIn: true },
  { op: 'kill', method: 'switcher' },
  { op: 'launch' },
  { op: 'expect', signedIn: true },
  { op: 'kill', method: 'reboot' },
  { op: 'launch' },
  { op: 'expect', signedIn: true },
  { op: 'readBuild' },
  { op: 'expectBuild' },
  { op: 'shot', name: 'relaunch' },
  { op: 'shutdown' }, // the run's last sim job: nothing else needs it, and it's the heaviest thing on the Mac
];

// What these rows can see: the keyboard's lift and the fields it covers, zoom, the shell and its insets, staying signed
// in, the service worker's second launch. `app/**` would rerun the sim on every app change, ~6 min a run for most of them
// nothing iOS can see (Rahul, 2026-11-05). Elsewhere an iOS-only bug waits for --tier all or naming the scenario.
const APP = [
  'app/index.html',
  'app/vite.config.ts',
  'app/pwa/**',
  'app/src/main.tsx',
  'app/src/index.css',
  'app/src/auth/**',
  'app/src/lib/useKeyboardInset.ts',
  'app/src/components/AppNav.tsx',
  'app/src/components/AppShell.tsx',
  'app/src/components/Modal/**',
  'app/src/modules/capture/CaptureBar.tsx',
  'app/src/modules/capture/mode.ts',
  'app/src/modules/capture/useAutoGrow.ts',
  'app/src/modules/tasks/QueryControls.tsx',
  'app/src/modules/tasks/DoneForm.tsx',
  'app/src/modules/tasks/TaskModal.tsx',
  'app/src/modules/tasks/editor/TaskEditor.tsx',
  'app/src/modules/tasks/notes/NotesField.tsx',
];
const HARNESS = [
  'tools/mailroom/jobs/sim.sh',
  'scripts/src/mailroom/sim.ts',
  'scripts/src/devcheck/ios.ts',
  'scripts/src/devcheck/scenarios/ios-standalone.ts',
];

export const iosStandalone: Scenario = {
  id: 'ios-standalone',
  title: 'iOS: the Home Screen app on the Mac’s Simulator',
  tiers: ['full'],
  slowPaths: [...APP, ...HARNESS],
  rows: [
    {
      id: 'launch-signed-in',
      entry: 'ios',
      kind: 'nominal',
      what: 'The Home Screen app launches standalone and signed in',
    },
    {
      id: 'two-launch-refresh',
      entry: 'ios',
      kind: 'nominal',
      what: 'After a deploy the app runs the new build by its second launch (the first may still run the old one)',
    },
    {
      id: 'survives-terminate',
      entry: 'ios',
      kind: 'edge',
      what: 'Killed by the system, it relaunches signed in',
    },
    {
      id: 'survives-switcher',
      entry: 'ios',
      kind: 'edge',
      what: 'Swiped away in the app switcher, it relaunches signed in',
    },
    {
      id: 'survives-reboot',
      entry: 'ios',
      kind: 'edge',
      what: 'After a phone restart it relaunches signed in',
    },
    {
      id: 'capture-above-keyboard',
      entry: 'ios',
      kind: 'nominal',
      what: 'Focusing the capture bar lifts it above the soft keyboard',
    },
    {
      id: 'capture-no-zoom',
      entry: 'ios',
      kind: 'edge',
      what: 'Focusing the capture bar doesn’t zoom the page',
    },
    {
      id: 'capture-neighbour',
      entry: 'ios',
      kind: 'edge',
      what: 'The Log/Task/Idea row stays above the keyboard too',
    },
    {
      id: 'capture-draft-not-saved',
      entry: 'ios',
      kind: 'edge',
      what: 'A typed draft enables Save log; erased, the placeholder is back and Save log is off',
    },
    {
      id: 'capture-long-page',
      entry: 'ios',
      kind: 'edge',
      what: `On a long page scrolled down, a Task-mode Review's preview row in the lifted dock clears the keyboard's accessory bar by at least ${CLEARANCE} pt`,
    },
    {
      id: 'done-form-above-keyboard',
      entry: 'ios',
      kind: 'nominal',
      what: 'The task modal’s Done form keeps the Reflection box above the soft keyboard when focused',
    },
    {
      id: 'done-form-no-zoom',
      entry: 'ios',
      kind: 'edge',
      what: 'Focusing the Reflection box doesn’t zoom the page (16px)',
    },
    {
      id: 'done-form-refocus',
      entry: 'ios',
      kind: 'edge',
      what: 'Blur and focus it again: still above the keyboard',
    },
    {
      id: 'done-form-draft-cleared',
      entry: 'ios',
      kind: 'edge',
      what: 'A reflection typed and erased, then Cancel, saves nothing',
    },
    {
      id: 'ios-never-writes',
      entry: 'api',
      kind: 'edge',
      what: 'After the sim steps the task is untouched: in progress, no reflection, no time logged',
    },
    {
      id: 'fresh-sign-in',
      entry: 'ios',
      kind: 'edge',
      what: 'After the 30-day refresh token lapses the runner signs in from the Mac Keychain',
      needsYou:
        'only when the token has lapsed (≤ monthly); the report’s iOS section shows signedIn: fresh when it did — forcing it would clear the service worker too',
    },
    {
      id: 'capture-refocus',
      entry: 'ios',
      kind: 'edge',
      what: 'A second focus after a real hardware keyboard was used',
      needsYou: 'the sim never has a real hardware keyboard; on the phone with one paired',
    },
    {
      id: 'done-form-neighbour',
      entry: 'ios',
      kind: 'edge',
      what: 'The Actual field may scroll under the keyboard while Reflection has focus — fine or not',
      needsYou: 'a judgement on the phone, not an assertion',
    },
    {
      id: 'pinch-zoomed-no-lift',
      entry: 'ios',
      kind: 'edge',
      what: 'Pinch-zoomed, a focused field doesn’t jump',
      offDev: {
        file: 'app/src/lib/useKeyboardInset.test.tsx',
        test: "doesn't lift when pinch-zoomed",
        why: 'the sim can’t pinch, so dev can’t produce it',
      },
    },
    {
      id: 'page-field-no-lift',
      entry: 'ios',
      kind: 'edge',
      what: 'A page field’s keyboard doesn’t lift the dock over it: Tasks search stays above the keyboard, the capture bar stays down',
    },
  ],
  steps: [
    {
      id: 'setup',
      title: 'An in-progress task for the Done form (MCP; the sim never taps Start)',
      entry: 'mcp',
      cost: 'slow',
      async run(ctx) {
        const t = await ctx.mcp.writes.createTask({ title: title(ctx), estimateMin: 15 });
        taskId = t.id;
        drove = false;
        await ctx.mcp.writes.updateTask(t.id, { status: 'in_progress' });
      },
    },
    {
      id: 'launch',
      title: 'Launch from the Home Screen, signed in, on the deployed build',
      entry: 'ios',
      cost: 'slow',
      proves: ['launch-signed-in', 'two-launch-refresh'],
      async run(ctx) {
        await ctx.ios.run('launch', LAUNCH);
      },
    },
    {
      id: 'capture',
      title: 'The capture bar above the soft keyboard; a draft typed and erased',
      entry: 'ios',
      cost: 'slow',
      proves: [
        'capture-above-keyboard',
        'capture-no-zoom',
        'capture-neighbour',
        'capture-draft-not-saved',
      ],
      async run(ctx) {
        await ctx.ios.run('capture', CAPTURE);
      },
    },
    {
      id: 'done-form',
      title:
        'The Done form’s Reflection box above the soft keyboard, refocused, a draft erased, cancelled',
      entry: 'ios',
      cost: 'slow',
      proves: [
        'done-form-above-keyboard',
        'done-form-no-zoom',
        'done-form-refocus',
        'done-form-draft-cleared',
        'page-field-no-lift',
      ],
      async run(ctx) {
        await ctx.ios.run('done-form', doneForm(ctx));
        drove = true;
      },
    },
    {
      id: 'capture-long',
      title:
        'On a long Tasks page scrolled down, a Review grows the lifted dock: its preview row clears the accessory bar',
      entry: 'ios',
      cost: 'slow',
      proves: ['capture-long-page'],
      async run(ctx) {
        // Padding planned for today, so Tasks (it opens on Today) is longer than the screen — backlog-only padding
        // isn't on that list, and left the page short (run 2026-11-08T19-19-51). Deleted again (its plans with it)
        // so later runs' Tasks lists start short.
        const pad: string[] = [];
        try {
          const { dayStartHour } = await ctx.api.reads.getSettings();
          const { today } = datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
          for (let i = 0; i < LONG_PAD; i++) {
            const t = await ctx.api.writes.createTask({ title: `devcheck-pad ${ctx.nonce} ${i}` });
            pad.push(t.id);
            await ctx.api.writes.upsertPlan({
              taskId: t.id,
              day: today,
              plannedMinutes: 15,
              order: i,
            });
          }
          // The warm app holds the list it loaded before the padding: relaunch so Tasks is long. Kill first, never a
          // launch onto the warm app: whatever the Done form step left up (its modal, when a Cancel tap dropped — run
          // 2026-11-08T23-00-16) hides Home's landmark from `launch`.
          const plan: IosOp[] = [
            { op: 'kill', method: 'terminate' },
            { op: 'launch' },
            ...CAPTURE_LONG,
          ];
          let r: SimResult;
          try {
            r = await ctx.ios.run('capture-long', plan);
          } catch (err) {
            const known = lowDock(err, plan);
            if (known) {
              ctx.log(`  low dock on a long page: ${known}`);
              needsYou(`${LOW_DOCK_KNOWN} (${known})`, { stepOnly: true });
            }
            throw err;
          }
          for (const as of ['long-bar', 'long-bar-task', 'long-field', 'long-preview']) {
            const note = r.steps?.find(
              (x) => x.op === 'expect' && x.note?.startsWith(`${as} `),
            )?.note;
            const c = clearanceOf(note);
            if (!c) throw new Error(`no clearance in the ${as} expect's note: ${note ?? 'none'}`);
            ctx.log(`  ${as} on a long page: bottom ${c.bottom}, accessory bar top ${c.top}`);
            if (c.top - c.bottom < CLEARANCE)
              needsYou(
                `${LOW_DOCK_KNOWN} (${as}'s bottom ${c.bottom} is ${c.top - c.bottom} pt above the accessory bar at ${c.top}, want ≥ ${CLEARANCE})`,
                { stepOnly: true },
              );
          }
        } finally {
          // Best effort: the API token can lapse inside a long sim job (a 401 on run 2026-11-08T19-48-02), and the
          // run's end sweep deletes ledgered tasks by id anyway (0 leftovers there). No later step reads Tasks.
          for (const id of pad)
            await ctx.api.writes
              .deleteTask(id)
              .catch((err: unknown) =>
                ctx.log(
                  `  padding ${id} left for the sweep: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
        }
      },
    },
    {
      id: 'relaunch',
      title: 'Killed three ways, relaunched signed in each time',
      entry: 'ios',
      cost: 'slow',
      proves: ['survives-terminate', 'survives-switcher', 'survives-reboot'],
      async run(ctx) {
        await ctx.ios.run('relaunch', RELAUNCH);
      },
    },
    {
      id: 'verify',
      title: 'The sim wrote nothing: the task is as set up',
      entry: 'api',
      cost: 'slow',
      proves: ['ios-never-writes', 'done-form-draft-cleared'],
      async run(ctx) {
        const t = await ctx.api.reads.getTask(taskId);
        if (!t) throw new Error('the task is gone');
        if (t.status !== 'in_progress') throw new Error(`status ${t.status}, want in_progress`);
        if (t.reflection) throw new Error('a reflection was saved');
        if (t.actualAccruedMin) throw new Error(`${t.actualAccruedMin} min logged`);
        // A change is a failure however far the sim got. No change only proves something if it drove the form:
        // a missing keyboard is that step's needs-you, and then "untouched" means nothing.
        if (!drove)
          needsYou('the Done form step never completed, so an untouched task proves nothing');
      },
    },
  ],
};
