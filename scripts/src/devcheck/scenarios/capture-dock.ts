// The capture dock on a phone (capture-dock-cleanup, 2026-11): the return key asks iOS for "send", Enter
// never submits a line an IME is still composing, and the dock lifts above the keyboard in a Safari tab as
// it does in the PWA. Headless Chromium has no IME and no on-screen keyboard, so those rows are the named
// unit tests; what dev can show is the hint on the field itself — the attribute is the whole contract iOS
// reads, so this is the one row that asserts an attribute rather than a result. Creates nothing.
import { noConsoleErrors, type Scenario } from '../scenario';

const CAPTURE_BAR = 'app/src/modules/capture/CaptureBar.test.tsx';
const INSET = 'app/src/lib/useKeyboardInset.test.tsx';
const NO_IME = 'headless Chromium has no IME; same keydown path as send-key';
const NO_KEYBOARD = 'headless Chromium has no on-screen keyboard, so visualViewport never shrinks';

export const captureDock: Scenario = {
  id: 'capture-dock',
  title: 'Capture dock: return key, IME Enter, keyboard lift',
  tiers: ['full'],
  rows: [
    {
      id: 'send-key',
      entry: 'ui',
      kind: 'nominal',
      what: 'The capture field asks the phone keyboard for a Send return key, in every mode',
    },
    {
      id: 'ime-enter',
      entry: 'ui',
      kind: 'edge',
      what: 'Enter while an IME is composing keeps the text and saves nothing',
      offDev: { file: CAPTURE_BAR, test: 'Enter mid-IME composition never submits', why: NO_IME },
    },
    {
      id: 'ime-229',
      entry: 'ui',
      kind: 'edge',
      what: 'WebKit’s committing Enter (keyCode 229 after compositionend) likewise',
      offDev: {
        file: CAPTURE_BAR,
        test: 'a committing Enter with keyCode 229 never submits',
        why: NO_IME,
      },
    },
    {
      id: 'ime-cmd-enter',
      entry: 'ui',
      kind: 'edge',
      what: '⌘Enter while composing neither reviews nor saves',
      offDev: {
        file: CAPTURE_BAR,
        test: '⌘Enter mid-composition never reviews or saves',
        why: NO_IME,
      },
    },
    {
      id: 'ime-after',
      entry: 'ui',
      kind: 'nominal',
      what: 'Enter once the composition has ended saves as usual',
      offDev: { file: CAPTURE_BAR, test: 'Enter after compositionend saves as usual', why: NO_IME },
    },
    {
      id: 'pwa-lift',
      entry: 'ui',
      kind: 'nominal',
      what: 'In the PWA the dock still lifts by the hidden gap while the keyboard is up',
      offDev: {
        file: INSET,
        test: 'lifts by the hidden gap while the dock has focus, following pans',
        why: NO_KEYBOARD,
      },
    },
    {
      id: 'tab-lift',
      entry: 'ui',
      kind: 'edge',
      what: 'In a Safari tab with its toolbars collapsed the dock lifts by the full gap, not the toolbars-shown one',
      offDev: {
        file: INSET,
        test: 'lifts by the full gap in a Safari tab with collapsed toolbars',
        why: NO_KEYBOARD,
      },
    },
    {
      id: 'iphone-tab',
      entry: 'ios',
      kind: 'edge',
      what: 'iPhone Safari tab, scrolled so the toolbars collapse: tap capture, type "x | ~" — the chips row sits fully above the keyboard',
      needsYou:
        'only iOS Safari collapses its toolbars and anchors fixed elements to the viewable area',
    },
    {
      id: 'iphone-ime',
      entry: 'ios',
      kind: 'edge',
      what: 'iPhone with a Japanese kana keyboard: compose a word, confirm it with the return key — the text commits in place, nothing saves, no newline',
      needsYou:
        'only a real IME commits on Enter; CDP’s synthetic composition leaves the un-prevented Enter to insert a newline, which says nothing about iOS',
    },
    {
      id: 'iphone-send',
      entry: 'ios',
      kind: 'nominal',
      what: 'iPhone PWA: the return key reads "send" in the capture field',
      needsYou: 'only the iOS keyboard renders the enterkeyhint label',
    },
  ],
  steps: [
    {
      id: 'send-key',
      entry: 'ui',
      proves: ['send-key'],
      title: 'Home: the capture field carries enterkeyhint="send" in Log and Task mode',
      async run(ctx) {
        await ctx.ui.goto('/');
        const field = ctx.page.getByLabel('Capture log', { exact: true });
        await field.waitFor({ timeout: 15_000 });
        const hint = await field.getAttribute('enterkeyhint');
        if (hint !== 'send') throw new Error(`Log mode: enterkeyhint is ${JSON.stringify(hint)}`);
        await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
        const task = ctx.page.getByLabel('Capture task', { exact: true });
        await task.waitFor({ timeout: 10_000 });
        const taskHint = await task.getAttribute('enterkeyhint');
        if (taskHint !== 'send')
          throw new Error(`Task mode: enterkeyhint is ${JSON.stringify(taskHint)}`);
        await task.click();
        await ctx.shot('capture-field');
      },
    },
    noConsoleErrors,
  ],
};
