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
      what: 'Start opens a sitting, then, on the shipped selectors, clicks LeetCode’s reset, confirms it, resets a timer left paused and starts it; a Submit lands in it with its verdict',
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
      what: 'Start opens the sitting first; LeetCode’s reset turned off in Options (null) → the overlay says it isn’t configured, and Continue without a clear goes active',
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
      id: 'ext-timer-restart',
      entry: 'extension',
      kind: 'edge',
      what: 'A timer left running or paused is reset first, then started in the mode LeetCode last used',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'restarts a timer left running or paused: LeetCode’s reset first, then Start from the pop-up that stays open',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-timer-name',
      entry: 'extension',
      kind: 'edge',
      what: 'An idle timer is opened under either name (Stopwatch, or Timer in countdown mode) and started',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'opens an idle timer under either name',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-timer-popup-closed',
      entry: 'extension',
      kind: 'edge',
      what: 'LeetCode’s pop-up closing after its reset still ends in a start (through the opener)',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'still starts when LeetCode’s pop-up closes after its reset',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-control-moved',
      entry: 'extension',
      kind: 'edge',
      what: 'A control that moved is named with its key, nothing else is clicked, Continue is offered, and a fix in Options works on Retry; debug mode records the timer’s controls',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'names the control it couldn’t find, clicks nothing else, and a fixed selector works on Retry; debug mode records the timer’s controls',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-toolbar-shift',
      entry: 'extension',
      kind: 'edge',
      what: 'An editor toolbar with one more icon: the reset reads as not found, and no neighbouring icon is clicked',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'finds no reset button when the toolbar gains an icon, rather than clicking a neighbour',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-retry-dialog',
      entry: 'extension',
      kind: 'edge',
      what: 'Retry after a failed confirm repeats the confirm while LeetCode’s dialog is open and clicks the reset again once it was cancelled; the streaks pop-over never counts as that dialog',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'Retry after a failed confirm goes back to the reset once LeetCode’s dialog has gone, and repeats the confirm while it is open',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-timer-confirm-missing',
      entry: 'extension',
      kind: 'edge',
      what: 'LeetCode’s timer never asks to confirm its reset: named (timerResetConfirm); a Retry after our overlay dismissed its pop-up clicks Reset again, never the closing one',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'says LeetCode’s timer didn’t ask to confirm its reset; Retry after our overlay dismissed its pop-up clicks Reset again, not the closing one',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-timer-still-asking',
      entry: 'extension',
      kind: 'edge',
      what: 'A Retry that finds LeetCode’s timer pop-up still open and asking confirms it without clicking Reset again',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a Retry that finds LeetCode’s pop-up still open and asking confirms it, without clicking Reset again',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-timer-no-reset',
      entry: 'extension',
      kind: 'edge',
      what: 'LeetCode’s timer reset never lands: “didn’t reset”, and no Start is clicked',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'says LeetCode’s timer didn’t reset when its Reset never lands, and clicks no Start',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-timer-off',
      entry: 'extension',
      kind: 'edge',
      what: 'A timer key set to null in Options: “isn’t configured”, none of its controls clicked, Continue goes active',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a timer key turned off in Options says the timer isn’t configured and clicks none of its controls',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-background-ascii',
      entry: 'extension',
      kind: 'edge',
      what: 'The background page’s scripts are pure ASCII, so Safari’s reading of them can’t break the “sitting ended” match (seen: events after a Done landed as failed)',
      offDev: {
        file: 'extension/test/background.test.ts',
        test: 'loads only pure-ASCII scripts in the background page, whatever encoding Safari reads them in',
        why: `${noStep}; a static check over the manifest’s background scripts`,
      },
    },
    {
      id: 'ext-next-title',
      entry: 'extension',
      kind: 'edge',
      what: 'After Next, the overlay and the Start name the new problem, not the one the tab title still names (seen in Safari)',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'names the new problem after Next, not the one the tab title still names, and Starts it under that name',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-next-stale-meta',
      entry: 'extension',
      kind: 'edge',
      what: 'A Start right after Next sends no difficulty or tags rather than the last problem’s, while the page still shows it',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'Starts with no difficulty or tags rather than the last problem’s, while the page still shows it',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-done-elsewhere',
      entry: 'extension',
      kind: 'edge',
      what: 'Coming back to the tab after a Done marked in Aperture: the badge learns the sitting ended (seen: it stayed on “waiting for the first sync”)',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'coming back to the tab re-sends LeetCode’s timer reading, so the badge learns of a Done marked in Aperture',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom; the reply-to-ended half is background.test.ts’s (a 200 whose status says ended, inside the grace, and a 400 past it)`,
      },
    },
    {
      id: 'ext-handoff-retry',
      entry: 'extension',
      kind: 'edge',
      what: 'A hand-off Safari refuses (“Tab not found”) is retried in order, and its events land once (seen: a Run lost)',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'retries a hand-off Safari refuses (Tab not found), in order, and every refused event lands once',
        why: `${noStep}; Safari’s refusal can’t be produced on purpose — the test throws its exact error`,
      },
    },
    {
      id: 'ext-badge-reread',
      entry: 'extension',
      kind: 'edge',
      what: 'The badge reads the background’s word itself while a sitting is open, so “synced” and “Sitting ended” show even when Safari doesn’t pass storage changes on (seen: events landed, the badge stayed on “waiting for the first sync”)',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'reads the background’s word itself when Safari doesn’t pass its storage changes on: synced, then ended',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-handoff-stuck',
      entry: 'extension',
      kind: 'edge',
      what: 'A hand-off every try refused is kept, the badge says to keep the tab open (a reload would lose it; reload only when the extension itself is gone), and it lands on coming back',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'keeps a hand-off every try refused, says to keep the tab open (not reload) until it lands, and sends it again on coming back',
        why: `${noStep}; Safari’s refusal can’t be produced on purpose — the test throws its exact error`,
      },
    },
    {
      id: 'ext-selector-paste',
      entry: 'extension',
      kind: 'edge',
      what: 'Every shipped selector is valid CSS; an override (null turns a step off) merges; a bad paste or the retired timerClicks falls back to the defaults',
      offDev: {
        file: 'extension/test/libs.test.ts',
        test: 'ships LeetCode’s controls from the debug log; null turns a step off; a bad paste and the retired timerClicks fall back',
        why: `${noStep}; merge() is a pure function`,
      },
    },
    // lc-polish: the problem doc from the page's __NEXT_DATA__, the Start overlay's scrim, the GraphQL-bodies probe.
    {
      id: 'ext-page-doc',
      entry: 'extension',
      kind: 'nominal',
      what: 'A fresh load’s Start carries the problem doc LeetCode rendered into the page, so the sitting has its statement and companies',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a fresh load’s Start carries the statement and the companies, read as the server reads them',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom, with a __NEXT_DATA__ tag shaped as debug log 8 found it`,
      },
    },
    {
      id: 'ext-page-doc-load',
      entry: 'extension',
      kind: 'edge',
      what: 'Scripts that run while the page still loads (Safari’s document_start) read the doc at DOMContentLoaded',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'reads it at DOMContentLoaded when the scripts ran while the page was still loading, as in Safari',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom, held at “loading” as Safari runs them`,
      },
    },
    {
      id: 'ext-page-doc-foreign',
      entry: 'extension',
      kind: 'edge',
      what: 'A page doc for another problem is never used, even once the address names that problem (after Next the tag still holds the first one’s)',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a page doc for another problem is ignored, even once the address names it',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-page-doc-fetched',
      entry: 'extension',
      kind: 'edge',
      what: 'A doc LeetCode fetches wins over the page’s',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'LeetCode’s fetched doc wins over the page’s',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-page-doc-id',
      entry: 'extension',
      kind: 'edge',
      what: 'The page doc’s question id is never trusted: a forged one still lets the sitting’s snapshots through',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'never takes a question id from the page: a forged one still lets the sitting’s snapshots through',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom; dev can’t forge LeetCode’s page`,
      },
    },
    {
      id: 'ext-page-doc-resume',
      entry: 'extension',
      kind: 'edge',
      what: 'A reload fills in the doc a Start went without',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a reload fills in the doc a Start went without',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-page-doc-late',
      entry: 'extension',
      kind: 'edge',
      what: 'A doc that comes while Start is still going is sent once the sitting is active',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a doc that comes while Start is still going is sent once the sitting is active',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom, with Aperture’s answer held`,
      },
    },
    {
      id: 'ext-doc-fit',
      entry: 'extension',
      kind: 'edge',
      what: 'The doc goes whole under 64 KB, else only the eight fields read, else not at all',
      offDev: {
        file: 'extension/test/wire.test.ts',
        test: 'fits a doc to the cap: whole when it fits, else the fields A1 reads, else nothing',
        why: `${noStep}; fitProblem is a pure function`,
      },
    },
    {
      id: 'ext-scrim',
      entry: 'extension',
      kind: 'nominal',
      what: 'The Start overlay’s scrim is near-solid (0.94) and blurred 20 px under both property names',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'hides the editor: near-solid, blurred under both names; its probe is logged',
        why: `${noStep}; the CSS is checked as shipped — how Safari paints it is ext-scrim-safari`,
      },
    },
    {
      id: 'ext-graphql-probe',
      entry: 'extension',
      kind: 'edge',
      what: 'Each relayed response says how the page world read it (or why it couldn’t), a few fixed words for the debug log; a json, document or arraybuffer XHR goes without its body',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'says how it read each response, for the debug log’s probe — a few fixed words, no content',
        why: `${noStep}; the real page-world script runs in jsdom over both transports`,
      },
    },
    {
      id: 'ext-blob-xhr',
      entry: 'extension',
      kind: 'nominal',
      what: 'A blob XHR’s questionDetail and submissionDetails (as Safari sends LeetCode’s GraphQL) ship as text, xhr:blob-ok, and classify as problem and submitDetails',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'reads a blob XHR’s response as text, as Safari sends LeetCode’s GraphQL',
        why: `${noStep}; the real page-world script runs in jsdom over a fake blob XHR`,
      },
    },
    {
      id: 'ext-blob-browser',
      entry: 'extension',
      kind: 'nominal',
      what: 'In a real browser, a blob XHR’s GraphQL is read through the pinned getters, and the page’s own read is unchanged',
      offDev: {
        file: 'scripts/src/lc-e2e/extension.test.ts',
        test: 'reads LeetCode’s GraphQL from a real blob XHR, and the page still gets its own',
        why: `${noStep}; the Chrome E2E runs the real extension on the fake page with its GraphQL over blob XHRs`,
      },
    },
    {
      id: 'ext-blob-limits',
      entry: 'extension',
      kind: 'edge',
      what: 'A blob that is empty, over 1 MB (never read), null or not a Blob goes without its body, named; one of exactly 1 MB is read; invalid JSON ships with no items',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'sends a blob XHR without its body when it is empty, too big or not a Blob, and says which',
        why: `${noStep}, and dev can’t make LeetCode answer these on cue`,
      },
    },
    {
      id: 'ext-blob-read-fail',
      entry: 'extension',
      kind: 'edge',
      what: 'A blob whose text() rejects or throws goes as xhr:blob-read-fail with no body, and later messages still flow',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'says the read failed when a blob’s text never comes, and keeps relaying',
        why: `${noStep}, and no browser fails a read on cue`,
      },
    },
    {
      id: 'ext-blob-patched',
      entry: 'extension',
      kind: 'edge',
      what: 'A page script that patches Blob’s text and size, FileReader, the XHR’s response (on its prototype or the instance) and Promise’s then after load can’t change what is captured',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'relays the real blob when a page script patches Blob, FileReader and XMLHttpRequest after load',
        why: `${noStep}; the real page-world script runs in jsdom, patched as a hostile page would`,
      },
    },
    {
      id: 'ext-blob-reuse',
      entry: 'extension',
      kind: 'edge',
      what: 'An XHR sent again before its blob is read, and again after, gives one message per send, each request with its own response (text XHRs too)',
      offDev: {
        file: 'extension/test/replay.test.ts',
        test: 'keeps each request with its own response when an XHR is sent again before the blob is read',
        why: `${noStep}; the real page-world script runs in jsdom, the XHR reused as a page could`,
      },
    },
    {
      id: 'ext-doc-ahead',
      entry: 'extension',
      kind: 'edge',
      what: 'The doc LeetCode fetches before Next is kept for its own problem, never used for the one on screen, and the next problem’s Start carries it; a ninth doc evicts the oldest',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'keeps the doc LeetCode fetched before Next, and the next problem’s Start carries it',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-blob-sitting',
      entry: 'extension',
      kind: 'nominal',
      what: 'With LeetCode’s GraphQL over blob XHRs: Next, Start, Submit — the Start has the problem doc and a submitDetails event is sent',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'with GraphQL over blob XHRs, a Next’d problem’s Start has its doc and a Submit its details',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom, its GraphQL over blob XHRs`,
      },
    },
    {
      id: 'ext-blob-safari',
      entry: 'extension',
      kind: 'nominal',
      what: 'In Safari: xhr:blob-ok with items in the debug log, the Next’d sitting has its statement and companies, the Submit its details, and no foreign-question',
      needsYou:
        'Safari has no automation of extensions — the Safari pass: fresh-load a problem, Just looking, Next, Start, a wrong Submit, Done in Aperture dev, export the log',
    },
    {
      id: 'ext-page-doc-clean',
      entry: 'extension',
      kind: 'edge',
      what: 'Any doc, however deep or odd its numbers, is cleaned to what A1’s payloadError accepts — the extension’s copy of the rule can’t drift from the server’s',
      offDev: {
        file: 'extension/test/wire.test.ts',
        test: 'always yields what A1’s payloadError and normalizeSittingStart accept, however hostile the doc',
        why: `${noStep}; cleanProblem is a pure function, run against A1’s own payloadError`,
      },
    },
    {
      id: 'ext-page-doc-unstorable',
      entry: 'extension',
      kind: 'edge',
      what: 'A page doc A1 couldn’t store as given never blocks the Start: it goes cleaned, every storable field kept',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'a page doc A1 couldn’t store never blocks the Start: it goes cleaned, everything storable kept',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom, its Start through A1’s normalizer`,
      },
    },
    {
      id: 'ext-frontend-id',
      entry: 'extension',
      kind: 'edge',
      what: 'The page doc may give the display number (frontendId), digits only and up to six, never the question id',
      offDev: {
        file: 'extension/test/overlay.test.ts',
        test: 'takes the page’s display number only as up to six digits',
        why: `${noStep}; both worlds’ real scripts run over the fake page in jsdom`,
      },
    },
    {
      id: 'ext-statement-safari',
      entry: 'extension',
      kind: 'nominal',
      what: 'In Safari, a Start on a freshly loaded problem gives the sitting its statement and companies (get_sitting), and the debug log’s pageDoc says found and fit',
      needsYou:
        'Safari has no automation of extensions — the Safari pass: fresh-load a problem, Start, Done in Aperture dev, export the log',
    },
    {
      id: 'ext-scrim-safari',
      entry: 'extension',
      kind: 'nominal',
      what: 'In Safari, nothing of the editor is readable through the Start overlay, and the debug log’s scrim says the blur applied',
      needsYou:
        'only Safari’s own paint shows it (a closed shadow root on a fixed host) — the Safari pass’s first step, by eye',
    },
    {
      id: 'ext-selectors',
      entry: 'extension',
      kind: 'nominal',
      what: 'The shipped selectors find LeetCode’s real reset, its confirm and its timer’s controls, from a running timer and from an idle one',
      needsYou:
        'real Safari sittings on leetcode.com — from a running countdown, an idle one, a never-opened problem and a narrow pane, with the debug log exported (extension/README.md → LeetCode’s controls): only LeetCode’s real page has them',
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
