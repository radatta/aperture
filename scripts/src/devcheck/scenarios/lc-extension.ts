// The LeetCode extension (extension/, PR A2): the overlay's Start, capture, the outbox, the relay's forgery rules.
// No dev step can drive a browser extension (`extension` isn't a step entry), and the server half it calls is
// lc-sittings' — proven on dev as the test user there. So every row here is proven off dev — the Chrome E2E
// runs the real extension against a fake LeetCode page and A1's real BFF locally — or needs Rahul in Safari.
import { noConsoleErrors, type Scenario } from '../scenario';

const noStep = 'no dev step can drive the browser extension (`extension` is not a step entry)';

export const lcExtension: Scenario = {
  id: 'lc-extension',
  title: 'The LeetCode extension opens a sitting from its overlay and sends what LeetCode sends',
  tiers: ['full'],
  rows: [
    {
      id: 'ext-start',
      entry: 'extension',
      kind: 'nominal',
      what: 'Start clicks LeetCode’s reset, confirms it, starts its timer and opens a sitting; a Submit lands in it with its verdict',
      offDev: {
        file: 'scripts/src/lc-e2e/extension.test.ts',
        test: 'Start resets the editor, starts the timer and opens a sitting; a submit lands with its verdict',
        why: `${noStep}; the Chrome E2E runs the real extension on a fake LeetCode page against A1’s real BFF locally`,
      },
    },
    {
      id: 'ext-resume',
      entry: 'extension',
      kind: 'edge',
      what: 'A reload mid-sitting resumes with no overlay and no reset; moving to another problem re-prompts, and its Start is refused while one is open',
      offDev: {
        file: 'scripts/src/lc-e2e/extension.test.ts',
        test: 'resumes a reload mid-sitting with no overlay and no reset, and re-prompts on SPA navigation where a second Start is refused',
        why: `${noStep}; the Chrome E2E reloads and navigates the fake LeetCode page`,
      },
    },
    {
      id: 'ext-just-looking',
      entry: 'extension',
      kind: 'edge',
      what: 'Just looking leaves the editor alone, captures nothing, and isn’t asked again for that problem this session',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'Just looking dismisses without touching the editor, and is remembered for the problem',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-reset-missing',
      entry: 'extension',
      kind: 'edge',
      what: 'LeetCode’s reset button isn’t found → the overlay says so; Start anyway opens the sitting without a clear',
      offDev: {
        file: 'extension/test/overlay-state.test.ts',
        test: 'says the reset button was not found, and Start anyway goes straight to the server start',
        why: `${noStep}, and dev can’t remove LeetCode’s button; the decision is the pure state machine`,
      },
    },
    {
      id: 'ext-wire',
      entry: 'extension',
      kind: 'nominal',
      what: 'The page-side capture reads every LeetCode shape captured on 2026-11-08: Runs without /v2/, the replay string, questionDetail, submit pairing',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'classifies every captured LeetCode shape: Runs without /v2/, the replay string, questionDetail, submit pairing',
        why: `${noStep}; the real page-world script runs in jsdom over both of LeetCode’s transports`,
      },
    },
    {
      id: 'ext-outbox',
      entry: 'extension',
      kind: 'edge',
      what: 'A 401 from Aperture pauses sending and is shown; a 5xx retries in order; a refused batch is kept as failed',
      offDev: {
        file: 'extension/test/outbox.test.ts',
        test: 'keeps a 401-rejected entry as failed and visible, and retries a 5xx in order behind nothing',
        why: `${noStep}, and dev can’t be made to answer 401 or 503 on cue`,
      },
    },
    {
      id: 'ext-forgery',
      entry: 'extension',
      kind: 'edge',
      what: 'A page script’s event without the stamp, out of sequence, or for another problem is dropped',
      offDev: {
        file: 'extension/test/relay.test.ts',
        test: 'drops a page script’s event without the stamp, out of sequence, or for another slug',
        why: `${noStep}; the relay's acceptance rules are one pure function`,
      },
    },
    {
      id: 'ext-selectors',
      entry: 'extension',
      kind: 'nominal',
      what: 'LeetCode’s real reset, its confirm and its timer start are found by the configured selectors',
      needsYou:
        'the ~5-minute debug session in Safari on leetcode.com (README → Debug mode): only LeetCode’s real page has them',
    },
    {
      id: 'ext-start-safari',
      entry: 'extension',
      kind: 'nominal',
      what: 'One real sitting in Safari against dev: Start, type, ⌘↵, and it shows in Aperture',
      needsYou:
        'Safari has no headless mode and no automation of extensions — one real sitting through the temporary extension',
    },
  ],
  steps: [noConsoleErrors],
};
