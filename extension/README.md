# Aperture LeetCode Capture (MV3 — Safari, Firefox)

A personal browser extension (Safari daily, Firefox signed) that records **your own** LeetCode submissions — accepted **and** wrong — to your Aperture backend as they happen. It authenticates with a **device token** you set in the options page; it never touches or transmits your LeetCode credentials.

> **Never run this against LeetCode from within the repo tooling; it is the user's to load and use.** This directory is code only. Do not invoke it, load it, or make any LeetCode/backend network calls from automation.

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

Open the extension's **options** page — Safari: Settings → Extensions → the extension → Settings (options are per Safari profile); Firefox: Add-ons Manager → Aperture LeetCode Capture → Preferences, or the "Options" link on the debugging page — and set:

- **API origin** — scheme + host of your Aperture backend, e.g. `https://aperture.example.com` (no trailing path).
- **Device token** — your Aperture device token.

On **Save** the extension stores both in `storage.local` and requests the optional host permission for that origin (`<origin>/*`) so the background script can POST to it. If you decline the permission, attempts won't send until you grant it.

## Wire contract

Each captured submission is sent once as:

```
POST <apiOrigin>/api/recordLeetcodeAttempt
x-aperture-authorization: Bearer <deviceToken>
content-type: application/json

{ "args": [ payload ] }
```

`x-aperture-authorization` mirrors `packages/shared/src/rpc.ts` `AUTH_HEADER`; it's hardcoded because the extension can't import from the workspace.

`payload`:

```
{
  leetcodeSubmissionId: string,   // submission_id, as a string
  problemSlug: string,            // from the submit URL /problems/<slug>/submit/
  problemTitle: string,           // document.title minus " - LeetCode", else title-cased from slug
  statusCode: number,             // status_code from /v2/check/ (10 AC, 11 WA, 12 MLE, 14 TLE, 15 RE, 20 CE)
  statusMsg: string,              // status_msg
  submittedAt: number,            // task_finish_time (epoch ms)
  tzOffsetMinutes: number,        // new Date().getTimezoneOffset(), stamped in background at send time
  lang: string,                   // pretty_lang, else the submit lang
  runtimeMs: number | null,       // status_runtime "0 ms" -> 0
  memory: number | null,          // `memory` bytes number (pretty "20.8 MB" string ignored)
  frontendId: string | null,      // question_id from the submit body if available, else null
  difficulty: string | null,      // header pill "Easy"/"Medium"/"Hard" from the DOM (null if not found)
  topicTags: string[] | null      // from /tag/ anchors in the DOM (null if topics are hidden)
}
```

## How it works

LeetCode's own network calls are observed and mirrored; nothing is blocked or altered. Why the extension
is passive, and why metadata comes from the DOM: `docs/areas/recruiting/index.md` → _Design decisions_.

- **Submit** — `POST https://leetcode.com/problems/<slug>/submit/`, body `{lang, question_id, typed_code}`, response `{submission_id}`. The interceptor remembers `submission_id -> {slug, lang, question_id}`.
- **Result poll** — `GET https://leetcode.com/submissions/detail/<submission_id>/v2/check/` (note `/v2/`), polled repeatedly. On the **first** response with `state === "SUCCESS"`, the extension fires **once** for that submission.
- **Metadata** — read straight from the **rendered page** at capture time (no network call): `title` from `document.title`, `difficulty` from the header Easy/Medium/Hard pill (link-nested similar-questions rows are skipped), `topicTags` from the `a[href^="/tag/"]` anchors (LeetCode server-renders these — see the design doc above). Best-effort: `title` degrades to a slug-derived string and `difficulty`/`topicTags` to `null` if not found (e.g. LeetCode is hiding topics behind a "Show Topics" toggle).

### MAIN vs ISOLATED worlds

Two content scripts run at `document_start`, both matching `*://leetcode.com/*`:

- **`src/inject-main.js`** runs in the page's **MAIN** world so it can monkey-patch `window.fetch` and `XMLHttpRequest` (the two transports LeetCode may use). MAIN-world code can read page globals but has **no** access to `browser.*` / `chrome.*`. When it has a payload it `window.dispatchEvent`s a `CustomEvent("aperture-leetcode-attempt", { detail })`.
- **`src/content-relay.js`** runs in the default **ISOLATED** world, listens for that event, and forwards the payload to the background via `runtime.sendMessage`. This bridge is necessary precisely because MAIN world can't call the extension APIs.
- **`src/background.js`** reads `{apiOrigin, deviceToken}` from `storage.local`, stamps `tzOffsetMinutes`, dedupes recently-sent submission IDs in memory (belt-and-suspenders; the server is authoritative), and performs the POST. Missing config or fetch errors are logged and dropped, never thrown.

All patched code is defensive: JSON parsing is wrapped in try/catch, the original request/response is always returned untouched, and nothing throws into the page.

## Notes

- LeetCode field shapes were verified against a real DevTools capture on **2026-08-09**.
- Icons are the Aperture mark rendered from `app/public/favicon.svg`; `icons/dev/` swaps the teal-green ground for brick red. Regenerate from the repo root with `rsvg-convert` (`librsvg2-bin`):

  ```sh
  for s in 48 96 128 256 512; do rsvg-convert -w $s -h $s app/public/favicon.svg -o extension/icons/icon-$s.png; sed 's/#33453f/#a8402c/g' app/public/favicon.svg | rsvg-convert -w $s -h $s -o extension/icons/dev/icon-$s.png; done
  ```

- No npm dependencies, no bundler, no build step. Plain JS, MV3, `browser.*` with a `chrome` fallback.
