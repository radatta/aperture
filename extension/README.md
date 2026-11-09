# Aperture LeetCode (MV3 — Safari, Firefox)

A personal browser extension (Safari daily, Firefox signed) for **sittings**: one go at one LeetCode problem, a rep of your LeetCode Roll in Aperture (`docs/areas/recruiting/index.md` → _Sittings_). On a problem page it puts up one **Start** button. Start clicks LeetCode's own editor reset, its "Are you sure" confirm and its timer, and opens the sitting. From then until you mark the rep Done in Aperture, it sends what LeetCode itself sends: your code as you type, every Run and Submit with its full result, your notes, LeetCode's timer and its replay stream. It authenticates with a **device token** you set in the options page; it never touches or transmits your LeetCode credentials.

> **Automation never reaches the real leetcode.com.** The tests run this code in jsdom and, in the E2E, in headless Chromium on a fake LeetCode page served at `leetcode.com` by a Playwright route, sending to a local server (_Tests_, below). Loading it on the real site is the user's.

## Build it for Safari (daily driver)

Safari needs the extension wrapped in a macOS app, signed with a **free Apple ID Personal Team**. Why that's enough, the per-stage setup, and expiry: `docs/areas/recruiting/index.md` → _Deployment & install_.

1. Convert, from the repo root (needs full Xcode, not just the Command Line Tools):
   - prod: `xcrun safari-web-extension-packager extension --macos-only --copy-resources --project-location ~/Desktop/ApertureSafari --app-name "Aperture LeetCode" --bundle-identifier dev.rahuldatta.ApertureLeetCode`
   - dev: the same **without** `--copy-resources` (the project then reads this folder live, so a rebuild picks up edits), with `~/Desktop/ApertureSafariDev`, `"Aperture LeetCode Dev"`, `dev.rahuldatta.ApertureLeetCodeDev`.
   - Ignore the `world` / `open_in_tab` "not supported" warnings (recruiting doc → _Safari: free signing_).
2. In Xcode, both targets → **Signing & Capabilities** → Automatically manage signing, Team = **(Personal Team)**.
3. **Expect "Embedded binary's bundle identifier is not prefixed with the parent app's bundle identifier" on the first ⌘R** — it hit both fresh prod builds. Fix: in each target's **General** tab, make the extension's Bundle Identifier the app's plus `.Extension` (exact case), make `extensionBundleIdentifier` in `Shared (App)/ViewController.swift` equal it, then ⇧⌘K and ⌘R. Same rule if you change a bundle ID.
4. **⌘R**, then copy the built app to `/Applications`, open that copy once, and delete the project's DerivedData folder (`~/Library/Developer/Xcode/DerivedData/Aperture_LeetCode-*` — spaces become underscores; `…Dev-*` for dev) — otherwise Safari lists the extension twice. **Every rebuild ends with this step**: the installed copy is frozen at the moment it was copied.
5. Safari → Settings → Extensions: enable it **only in its own profile** (prod in your personal profile, dev in an "Aperture Dev" one), and allow `leetcode.com` and the API origin.

After changing anything here: the prod project (made with `--copy-resources`) holds a **copy** of this folder, so re-copy the files into its `Shared (Extension)/Resources/` first; the dev project reads it live. Then rebuild and redo step 4.

**Dev icon.** Both builds read the same `manifest.json` (prod icons). The dev project swaps in `icons/dev/` with a **Run Script** phase on its Extension target, after Copy Bundle Resources, "Based on dependency analysis" unticked, and the target's `ENABLE_USER_SCRIPT_SANDBOXING = NO`:

```sh
set -eu
d="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/icons"
cp -f "$d"/dev/icon-*.png "$d"/
```

This needs `icons` to be a blue **folder reference** in Xcode (the packager's default); a yellow group flattens it and the two `icon-48.png` collide. The Dock/Applications icon is the app's `Assets.xcassets/AppIcon` — drag the matching PNGs in once.

## Load it in Firefox (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select this folder's `manifest.json`.

The add-on stays loaded until you restart Firefox (temporary add-ons don't persist). Requires Firefox **128+** for `content_scripts` `world: "MAIN"` support.

For the permanent (AMO-signed) Firefox install and the per-stage origins, see **`docs/areas/recruiting/index.md` → Deployment & install**.

## Configure

Open the extension's **options** page — Safari: Settings → Extensions → the extension → Settings (options are per Safari profile); Firefox: Add-ons Manager → Aperture LeetCode → Preferences — and set:

- **API origin** — scheme + host of your Aperture backend, e.g. `https://aperture.example.com`. `https` only (`http` for `localhost` / `127.0.0.1`), since the token rides on every request.
- **Device token** — your Aperture device token.

**Save** asks for permission to reach that origin (`<origin>/*`) — inside the click, which Safari and Firefox require — then stores both in `storage.local` and resumes a paused outbox. Decline it and nothing sends until you allow it.

The page also shows:

- **Last send** — the outbox's state, its last HTTP status and message, how many batches are queued or failed, and why each failed one was refused. **Retry now** puts failed batches back in line and ends every wait; **Clear failed** drops them (asks first).
- **Debug mode** — _Debug mode_, below.
- **Selectors** — overrides for where LeetCode's controls are, as JSON over the defaults in `src/lib/selectors.js`: `editorReset`, `resetConfirm`, `dialog`, and `timerClicks` (a list of selectors clicked in order). Open LeetCode tabs pick a change up at once — no rebuild, which matters for the prod Xcode build.

## The sitting, from LeetCode's side

1. **A problem page** (`/problems/<slug>/…`) puts up a full-screen overlay: the problem, the language, **Start** and **Just looking**.
2. **Start** runs four steps, each checked before the next — Aperture first, so a Start it refuses (another sitting open, no roll, a bad token, the origin or token unset) never touches the editor. The overlay's buttons act only on a real click (`isTrusted`); a LeetCode script's `click()` does nothing.
   1. `lcSittingStart` → the sitting is open (and bound, so a reload from here on resumes);
   2. click LeetCode's editor reset → a dialog appears;
   3. click its confirm → the dialog goes;
   4. click LeetCode's timer controls (`timerClicks`) → `QD_TIMER_STATE` in localStorage reads running, started just now — and the overlay gives way to a badge: `Aperture · 12m · synced 3s ago`.
3. **A step that fails** says which, in words ("Couldn't find LeetCode's reset button", "LeetCode's timer didn't start", the server's own message). Aperture refused: **Retry** (the send again — nothing was clicked) or **Just looking**. A click failed after Aperture said yes: **Retry** (that click) or **Continue without a clear** — the sitting is open either way, so Just looking isn't offered. Until the debug session fills in the selectors, the reset, confirm and timer are _not configured_ and say so; Continue still keeps the sitting. Leave it there and the sitting stays open, uncleared: a reload resumes it.
4. **Just looking** dismisses the overlay without touching anything, and isn't asked again for that problem until the browser session ends (`storage.session`). Nothing is captured for a problem with no sitting.
5. **A reload, or a second tab, mid-sitting** resumes with no overlay and no clicks (one Start call per sitting per page load — later visits in the same load trust the binding, so a page flipping the address can't turn into a stream of calls): the per-problem binding (`storage.local['sitting:<slug>']`) repeats the Start with the same `clientSittingId`, which A1 answers with the open sitting. Only Aperture saying the sitting is over (an ended sitting, `SITTING_ENDED_ERROR`, or a Start over a day old) clears the binding; a 401, a 404 or no answer keeps it, so a token change mid-solve never re-prompts you one click from a reset — the outbox holds the events and the badge says why.
6. **Moving to another problem** (LeetCode is a single-page app; the isolated world watches its own `location`) prompts again. A Start there while the first sitting is open is refused by Aperture — "Another sitting is still open — end it in Aperture first. Then Retry." The extension can't end a sitting itself: its token only starts sittings and adds events.
7. **The sitting ends in Aperture**, at Done (or Drop) on the rep — an Accepted submit never ends it. The next send learns it (`status` in the events reply, or `SITTING_ENDED_ERROR`), the badge says "Sitting ended in Aperture", the binding clears, and the next visit prompts again.
8. **The problem doc** — LeetCode's `questionDetail`, with its company tags — isn't sent on a fresh page load, only after a submit or a navigation. So Start reads the title, difficulty and tags from the page, and when a `questionDetail` for the problem arrives, the extension repeats the Start with it; A1 fills it in.

## Wire contract

Both calls go to the BFF as RPCs, from the background only:

```
POST <apiOrigin>/api/lcSittingStart       { "args": [ SittingStartInput ] }
POST <apiOrigin>/api/lcSittingEvents      { "args": [ { sittingId, events: SittingEventInput[] } ] }
x-aperture-authorization: Bearer <deviceToken>
content-type: application/json
```

The shapes, caps and error strings are `packages/shared/src/sittings.ts`; the extension mirrors what it must (`x-aperture-authorization` is `rpc.ts` `AUTH_HEADER`; `test/background.test.ts` checks the copies against the shared package, and the unit tests run the shared normalizers over what the extension makes).

- **Start** — `{clientSittingId (a ULID the extension mints), problemSlug, problemTitle, questionId, frontendId, difficulty, topicTags, lang, startedAt (the click), tzOffsetMinutes, lcSolveSessionId (LeetCode's qd_solve_session id), problem (questionDetail.question, when captured)}`. A repeat with the same id resumes; the reply is `{sitting, resumed}`.
- **Events** — at most 50 per call and 256 KB, each `{id (ULID), type, at, payload}` or a replay chunk `{id, type: 'replay', at, clientSessionId, events (text)}`:

| LeetCode traffic                                                                                           | event           | payload                                                        |
| ---------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------- |
| GraphQL `updateSyncedCode` (`{code, lang, questionId}`) — the full code as you type; one per 30 s ¹        | `snapshot`      | `{code, questionId, lang}`                                     |
| `POST /problems/<slug>/submit/` + its final `/submissions/detail/<id>/v2/check/`                           | `submit`        | `{submissionId, slug, request, result}` — at the submit's time |
| `POST /problems/<slug>/interpret_solution/` + its final `/submissions/detail/runcode_…/check/` (no `/v2/`) | `run`           | `{interpretId, slug, request, result}`                         |
| GraphQL `submissionDetails`                                                                                | `submitDetails` | `{submissionId, details}`                                      |
| GraphQL `updateNote`                                                                                       | `note`          | `{slug, content}`                                              |
| GraphQL `PracticeReplayUploadEvents`                                                                       | `replay`        | its `events` text, split along the array past 60 KB            |
| localStorage `QD_TIMER_STATE`, read every 2 s on change                                                    | `timer`         | `{state, heartbeat}`                                           |

¹ `lib/batch.js`: at most one snapshot per 30 s window, the latest code when the window closes (trailing), so live code is at most 30 s behind and a long sitting stays well under A1's per-sitting event cap; the pending one also goes ahead of a run or submit, and on hide or navigation. Other events batch for 3 s; a run or submit goes at once. The first snapshot after Start therefore lands up to 30 s later.

A run or submit LeetCode never judges is sent after two minutes with `result: {pending: true}`. GraphQL `syncedCode` (the saved code on load) only supplies the `questionId`; `questionDetail` only feeds Start.

**Statuses** (`lambdas/src/index.ts` → `ingestFailureStatus`): 200 **with the events reply** is sent — CloudFront answers an `/api` 403 or 404 with the app's `index.html` as a 200 (`cdk` `errorResponses`), so any other 200 is retried as "isn't its API"; **409, 429, 5xx and an unreachable server retry** with backoff (5 s, 30 s, 1, 2, then every 5 min, each send timing out at 30 s), in order — a waiting batch holds the ones behind it; **401 pauses** everything until Save in Options; **413 and a 400** split the batch in two until the refused event is alone (a 400 for the sitting's capture cap doesn't split); **`SITTING_ENDED_ERROR`** drops the batch — that is how a sitting ends, not a failure; **any other refusal is kept as failed** and shown — in the badge and in Options, never dropped silently. A run or submit over the server's per-event cap is trimmed to its verdict (LeetCode's long outputs first, then the typed code, which the snapshots carry) rather than lost; a full queue (2,000 entries / 5 MB) sheds its oldest snapshot-only batches, then other raw bulk (replay, submitDetails), never a run, submit or note.

## How it works

Three contexts, as Rahul's forgery rules require (`docs/areas/recruiting/index.md` → _Design decisions_): the page's world can be spoofed by any script on leetcode.com, so it is only ever a source of evidence.

```
leetcode.com page (MAIN world)          extension side of the page (ISOLATED)        background
page/tag.js, inject-main.js             lib/*, debug.js, overlay.js, content.js       lib/outbox.js, background.js
  watches fetch + XHR ──raw text,──▶     relay → wire parse → admit → batches ──msg──▶  outbox → POST to Aperture
  (passive; receives nothing) tagged     overlay, Start's clicks, binding    ◀─reply─  Start answered directly
```

- **`src/inject-main.js`** (MAIN, `document_start`) patches `window.fetch` and `XMLHttpRequest` to _observe_ LeetCode's own traffic — it never blocks or alters a request, makes none of its own, and nothing ever flows back to it. It parses nothing: each message is the raw URL (read once, and that same string goes to the real fetch or open), request text, response text and times. It loads `lib/tag.js` as a copy in `src/page/`, because Chrome runs a file listed in both worlds only once, in the first (seen 2026-11-08); `pnpm -F @aperture/extension sync-page` refreshes it, and `libs.test.ts` fails when it drifts. The lib is removed from the page's globals once read.
- **The relay.** At `document_start` the page world mints a 32-byte nonce and hands it to the isolated world in a hello; the isolated world acks in the same tick, after which the page world never repeats it. `lib/relay.js` `accept` takes a message only if its tag (HMAC-SHA256 over the body, keyed by the nonce) verifies, its sequence number is new and it is raw text of the right shape; the isolated world then parses it itself (`lib/wire.js`), and `admit` takes each item only if it is for the problem in the tab's address (read by the isolated world — though a page script can change it with `pushState`) and, for events, the extension itself opened a sitting for that problem. Anything else is dropped (counted in the debug log), as is a message over 6 MB or a backlog over 500. The page has no message that Starts anything: only the overlay, in the isolated world, can.
- **What the tag stops, and what it doesn't.** It stops a script on leetcode.com from minting a message or replaying one it heard: it can't sign without the key, a repeated sequence number is dropped, and the key never passes through anything the page can reach — the page world's crypto and promise calls are originals bound at load, called through `Reflect.apply`, and `then` is pinned to `undefined` on what those promises settle with (`Response`, `CryptoKey`, `ArrayBuffer`), so the browser's own promise resolution can't run a page-installed `then`. It does not make the page's traffic true. A patch made _after_ our capture can't make what we record differ from what LeetCode itself got: a `Response` counts only if the browser fetched it from leetcode.com (its own `type` and final URL — so a page-built one, or a `<base href>` sending a request elsewhere, is ignored; an XHR likewise by its `responseURL`), the message is strings and numbers in null-prototype objects (no page `toJSON` applies), and all parsing happens in the isolated world (`replay.test.ts` patches `Response`, `Promise`, `JSON`, `Array` and `Object.prototype`, builds Responses, and checks nothing changes). A problem doc counts only for the problem in the address, and a hint's question id only when none is known and no doc disagrees. **Accepted residual:** a script that patched `fetch`, `XMLHttpRequest` or the built-ins _before_ our script ran — including when Safari runs our isolated script after the page's (then page listeners can also run ahead of ours, and the handshake can be heard) — or that drives LeetCode's real editor, fakes traffic LeetCode itself receives, keeps an event from us (a `loadend` listener ahead of ours) or points the address at the open sitting's problem from another one, produces or loses messages for the one open sitting; the server's caps are the boundary. The debug log records the page's `readyState` at both scripts' start, so the Safari debug session shows whether ours ran first.
- **`src/content.js`** (ISOLATED) runs the overlay's state machine (`lib/overlay-state.js`, painted by `overlay.js` in closed shadow roots on `<html>`, outside React's `#__next` — no page script can read the overlay's text or Aperture's words; what it can see is whether the overlay and the badge show, so whether a sitting is active. A button acts only on a real click on an overlay that is really showing: the host a direct child of `<html>`, its style ours, nothing on it or `<html>` fading, hiding or moving it — checked at the click; the hosts are put back and kept last among `<html>`'s children every 500 ms. A page element in the browser's top layer, painted over the overlay and letting clicks through, is residual), Start's steps, the binding, the timer read, the parse (`lib/wire.js` over the relay's raw text), and the hand-off (`lib/batch.js`: 3 s batches, a snapshot per 30 s, a run or submit at once, a flush on `pagehide`, hide and navigation).
- **`src/background.js`** owns the device token and every POST. Start is answered directly; events go through the outbox (`lib/outbox.js`, persisted as `storage.local.outbox`, capped at 2,000 batches / 5 MB — over it, the oldest snapshot-only batches go first, never a run or submit). It re-arms itself with a timer and an alarm, so a retry survives the background being unloaded. It writes `status` (the outbox) and `sync:<slug>` (the sitting's last reply) for the badge and Options, and answers only messages from the extension itself.

**Storage keys** — `local`: `apiOrigin`, `deviceToken`, `selectors`, `debug`, `debugLog`, `outbox`, `status`, `sitting:<slug>`, `sync:<slug>`; `session`: `dismissed:<slug>`.

## Debug mode

For finding LeetCode's controls (the selectors above). Options → **Debug mode** on, then reload the LeetCode tab. It records, in `storage.local.debugLog` (last 2,000 entries): what you click (tag, text, `data-*`/`aria-*` attributes, a short HTML excerpt, a CSS path), every dialog that opens and its buttons, changes to `QD_TIMER_STATE`, `QD_TIMER_HEARTBEAT`, `global_lang` and `qd_solve_session:*`, the clocks on screen every 2 s, `__NEXT_DATA__`'s query keys, the handshake (with `document.readyState` when the isolated script ran — whether Safari's `document_start` is early enough), every relay drop and overlay step — and, when a Start step fails, every editor and labelled button on the page. Never code, request bodies or tokens: the wire entries are sizes, and credential-looking storage keys are redacted.

The session (≈5 minutes, on a problem you've solved): Just looking; hover each icon in the editor toolbar, click the reset, then its confirm; open the timer, start it, wait, pause, resume, reset; switch to the stopwatch and do the same; type a line; Run once; Next problem and back. Then Options → **Export debug log** (or **Copy JSON** — Safari may open a download in a tab), and the selectors come from it.

## Tests

- **Unit and jsdom** — `pnpm --filter @aperture/extension test` (in the gate): the pure libs against the shared package's own normalizers; `test/replay.test.ts` runs the real page-world script in jsdom over both transports; `test/overlay.test.ts` runs both worlds' scripts over the fake LeetCode page (`test/fixtures/`), reading the closed roots through an `attachShadow` wrapper and clicking through jsdom's internals with `isTrusted` set (`test/load.ts`, test-side only); `test/background.test.ts` runs the real background in a vm.
- **E2E** — `scripts/src/lc-e2e/extension.test.ts` (in `pnpm --filter @aperture/scripts test`; skipped where `~/pw` has no Playwright, as on CI): the real extension in headless Chromium (a copy with a service-worker background, `chrome-build.ts` — Chrome's MV3 refuses `background.scripts` — plus, in that copy only, the `scripting` permission and a script that keeps the closed roots in the isolated world, which the test reads through `chrome.scripting` and clicks at their real coordinates), on the fake page, against A1's real BFF run locally as the test user.
- **What none of them prove:** Safari, and LeetCode's real DOM. Those are the `lc-extension` dev-check scenario's _Needs you_ rows: the debug session, and one real sitting.

## Notes

- LeetCode shapes were verified against the 2026-11-08 captures (the table above; the capture notes are archived with the branch, `docs/areas/recruiting/index.md` → intro).
- Icons are the Aperture mark rendered from `app/public/favicon.svg`; `icons/dev/` swaps the teal-green ground for brick red. Regenerate from the repo root with `rsvg-convert` (`librsvg2-bin`):

  ```sh
  for s in 48 96 128 256 512; do rsvg-convert -w $s -h $s app/public/favicon.svg -o extension/icons/icon-$s.png; sed 's/#33453f/#a8402c/g' app/public/favicon.svg | rsvg-convert -w $s -h $s -o extension/icons/dev/icon-$s.png; done
  ```

- No npm runtime dependencies, no bundler, no build step: plain JS classic scripts, MV3, `browser.*` with a `chrome` fallback. The libs are UMD so the tests can require them; `package.json` exists for the tests only.
