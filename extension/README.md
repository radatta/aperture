# Aperture LeetCode Capture (Firefox MV3)

A personal Firefox extension that records **your own** LeetCode submissions — accepted **and** wrong — to your Aperture backend as they happen. It authenticates with a **device token** you set in the options page; it never touches or transmits your LeetCode credentials.

> **Never run this against LeetCode from within the repo tooling; it is the user's to load and use.** This directory is code only. Do not invoke it, load it, or make any LeetCode/backend network calls from automation.

## Load it in Firefox (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select this folder's `manifest.json`.

The add-on stays loaded until you restart Firefox (temporary add-ons don't persist). Requires Firefox **128+** for `content_scripts` `world: "MAIN"` support.

For the permanent (signed) install, the per-stage origins, and why dev validation belongs in a separate Firefox profile, see **`docs/areas/recruiting/index.md` → Deployment & install**.

## Configure

Open the extension's **options** page (Add-ons Manager → Aperture LeetCode Capture → Preferences, or the "Options" link on the debugging page) and set:

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
is passive, and why metadata comes from the DOM: `docs/areas/recruiting/index.md` → *Design decisions*.

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
- No icons are declared in the manifest (no binary assets fabricated), so it loads without an icon.
- No npm dependencies, no bundler, no build step. Plain JS, MV3, `browser.*` with a `chrome` fallback.
