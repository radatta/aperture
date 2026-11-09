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
      what: 'Start opens a sitting, then clicks LeetCode’s reset, confirms it and starts its timer; a Submit lands in it with its verdict',
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
      what: 'Start opens the sitting first; LeetCode’s reset isn’t configured (the shipped default) → the overlay says so, and Continue without a clear goes active',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'opens the sitting first, says LeetCode’s reset isn’t configured, and Continue without a clear goes active',
        why: `${noStep}, and dev can’t remove LeetCode’s button; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-page-click',
      entry: 'extension',
      kind: 'edge',
      what: 'A page script’s click on Start does nothing and it can’t read the overlay; a Start Aperture refuses (no origin or token set) clicks nothing on LeetCode',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'ignores a page script’s click on Start, and clicks nothing on LeetCode for a Start Aperture refuses',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-resume-refused',
      entry: 'extension',
      kind: 'edge',
      what: 'A reload whose resume Aperture refuses with a 401 keeps the sitting; only its end clears it',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'keeps the sitting when a reload’s resume is refused for any reason but its end',
        why: `${noStep}, and dev can’t be made to answer 401 on cue`,
      },
    },
    {
      id: 'ext-wire',
      entry: 'extension',
      kind: 'nominal',
      what: 'The page side ships raw every LeetCode shape captured on 2026-11-08, and the isolated side classifies it: Runs without /v2/, the replay string, questionDetail, submit pairing',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'ships every captured LeetCode shape raw, and the isolated world classifies it: Runs without /v2/, the replay string, questionDetail, submit pairing',
        why: `${noStep}; the real page-world script runs in jsdom over both of LeetCode’s transports`,
      },
    },
    {
      id: 'ext-outbox',
      entry: 'extension',
      kind: 'edge',
      what: 'A 401 from Aperture pauses sending and is shown; a 5xx retries in order; a refused event is kept as failed',
      offDev: {
        file: 'extension/test/background.test.ts',
        test: 'retries a 5xx in order, pauses on a 401 until the token changes, and keeps a 400 as failed',
        why: `${noStep}, and dev can’t be made to answer 401 or 503 on cue; the real background page runs in a vm`,
      },
    },
    {
      id: 'ext-not-api',
      entry: 'extension',
      kind: 'edge',
      what: 'A 200 that isn’t Aperture’s answer (CloudFront’s index.html for an /api 404) is retried, never counted as sent',
      offDev: {
        file: 'extension/test/background.test.ts',
        test: 'never counts a 200 that isn’t Aperture’s answer as sent (CloudFront’s index.html for an /api 404)',
        why: `${noStep}, and dev’s origin can’t be broken on cue; the real background page runs in a vm`,
      },
    },
    {
      id: 'ext-forgery',
      entry: 'extension',
      kind: 'edge',
      what: 'A page script’s message without the stamp, out of sequence, or not raw text of the right shape is dropped',
      offDev: {
        file: 'extension/test/relay.test.ts',
        test: 'drops a page script’s message without the stamp, out of sequence, or malformed',
        why: `${noStep}; the relay's acceptance rules are pure functions`,
      },
    },
    {
      id: 'ext-off-screen',
      entry: 'extension',
      kind: 'edge',
      what: 'A problem doc or hint counts only for the problem on screen; events only for its open sitting',
      offDev: {
        file: 'extension/test/relay.test.ts',
        test: 'admits a problem doc or hint only for the problem on screen, and events only for its open sitting',
        why: `${noStep}; the relay's acceptance rules are pure functions`,
      },
    },
    {
      id: 'ext-primordials',
      entry: 'extension',
      kind: 'edge',
      what: 'A page script that patches Response, Promise, JSON or Object.prototype after load can’t change what is captured',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'relays what LeetCode really sent when a page script patches Response, Promise and JSON after load',
        why: `${noStep}; the real page-world script runs in jsdom, patched as a hostile page would`,
      },
    },
    {
      id: 'ext-forged-response',
      entry: 'extension',
      kind: 'edge',
      what: 'A Response a page script built, or one a <base href> sent to another origin, is never captured; then stays pinned',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'ignores a Response the page built or one from another origin, and keeps then pinned',
        why: `${noStep}; the real page-world script runs in jsdom, fed what a hostile page would`,
      },
    },
    {
      id: 'ext-late-submit',
      entry: 'extension',
      kind: 'edge',
      what: 'A submit LeetCode judges after you moved to the next problem lands in its own problem’s sitting, not the new one',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'sends a submit judged after moving to the next problem to its own problem’s sitting',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-late-submit-list',
      entry: 'extension',
      kind: 'edge',
      what: 'A submit LeetCode judges after you left for the problem list still lands in its problem’s sitting',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'sends a submit judged after leaving for the problem list to its problem’s sitting',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-snapshots',
      entry: 'extension',
      kind: 'nominal',
      what: 'At most one snapshot per 30 s, the latest code; the pending one goes before a run or submit and on hide',
      offDev: {
        file: 'extension/test/batch.test.ts',
        test: 'sends at most one snapshot per 30 s window, the latest one, and the pending one before a run or submit and on hide',
        why: `${noStep}; the batching is a pure function over a fake clock; overlay.test.ts sees the snapshot ride with a submit and go on pagehide`,
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
