// The Home Screen web app on the Mac's iOS Simulator (docs/ops/IOS-CHECK.md): it launches signed in, survives
// three kinds of kill, picks up a deploy by its second launch, and keeps the capture bar and the Done form's
// Reflection box above the soft keyboard without zooming. Every step is slow (a sim run is minutes), so a full
// run defers them unless the branch touches app/ or names this scenario (DEV-CHECK.md → Slow tier).
// The sim never submits: the one task it opens is set up here through MCP, and the sim only focuses, types a
// draft by key taps and erases it. Coordinates are points on the iPhone 18 Pro Max (440×956), from the 2026-11-05
// re-measure (keyboard up, the capture bar sits at y 462); a MISS after an app change means a plan needs new ones —
// read the step's screenshot.
import type { Ctx, Scenario } from '../scenario';
import type { IosOp } from '../../mailroom/sim';

// One keyboard layer only (`keys` takes ^[a-z ]+$): the nonce with its digits as letters.
const marker = (ctx: Ctx) =>
  ctx.nonce
    .toLowerCase()
    .replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a')
    .replace(/[^a-z]/g, '')
    .slice(0, 12);
const title = (ctx: Ctx) => `devcheck-ios ${marker(ctx)}`;
let taskId = '';

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
  { op: 'keys', text: 'zzqx' },
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
  { op: 'erase', n: 4 },
  { op: 'expect', as: 'bar', valueIs: 'What happened?' },
  { op: 'expect', as: 'send', enabled: false },
  { op: 'blur' },
];

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
  { op: 'keys', text: marker(ctx) },
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
  { op: 'keys', text: 'zzqx' },
  { op: 'erase', n: 4 },
  { op: 'blur' },
  { op: 'tap', label: 'Cancel', scan: { x: 120, from: 150, to: 720 }, role: 'AXButton' },
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
];

const APP = ['app/**'];
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
      what: 'After the 7-day refresh token lapses the runner signs in from the Mac Keychain',
      needsYou:
        'only when the token has lapsed (≤ weekly); the report’s iOS section shows signedIn: fresh when it did — forcing it would clear the service worker too',
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
      },
    },
  ],
};
