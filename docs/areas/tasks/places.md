# Places (errand lists + the iPhone Shortcut)

**Area:** tasks · **Branch:** `places-shortcuts`

**Status: building 2026-11-03.** PR 1 of the reminders feature (prod task "Reminders + notifications"). PR 2 adds
Declarative Web Push for timed reminders (09:00 for day-only tasks, planned-day pings, a GCal popup on timed
events); PR 3 the morning/night ritual nudges. Research and path comparison: the branch's
`localNotes/synthesis.md` (archived with the branch).

Permanent design-of-record: §6 is the decision log, §7 the build record. Where this doc and the code disagree,
fix whichever is wrong and say so here.

---

## 1. Why

Most of what went overdue in September was errands a ping would have caught — shampoo, nails, caramel syrup.
They aren't timed work; they're things to pick up _when you're at the store_. A PWA can't watch your location,
but the iPhone can: a Shortcuts **Arrive** automation geofences on-device and runs a Shortcut when you get
there. Aperture only has to answer "what's on the Safeway list?".

## 2. Shape

```
iPhone (on-device)                                  Aperture
─────────────────                                   ────────
Arrive at Safeway (Main St)  ── automation ──┐
Arrive at Safeway (Elm St)   ── automation ──┤ Run Shortcut "Aperture list", input "safeway"
                                             ▼
Shortcut "Aperture list"  ── GET /api/places/safeway/tasks ──▶  place token → user → open errands
   if text → Show Notification       ◀── { count, titles, text, url } ──┘
```

- **Place** (`types.ts`): `{ name, slug, lastReadAt }`, one per store you name; a short list edited in Settings ›
  Places. No address — the geofence lives only in the Shortcuts automation, never in Aperture.
- **`Task.place`**: the place's slug, or null. A placed task is an **errand**: it shows in the **Places** lens
  (§3), and it is **never a calibration point**, even with an estimate typed (`contributesCalibration`). A slug
  edit rewrites the place's tasks; deleting a place asks where its tasks go (another place, or off any list — finished errands keep the old slug,
  D3).
- **Parts**: a part's place is always its parent's — parts are created with it, `setTaskPlace` refuses a part and
  carries a parent's open parts along, attaching a part gives it the parent's place. The digest lists the
  _items_: a parent with open parts is left out and its parts listed, so the Shortcut, Settings' count and the lens
  agree.
- **Grammar**: `shampoo | @safeway` (bulk add + capture's token line, `bulkTasks.ts`); in a natural-language quick
  add, a known `@slug` word is taken before the model call (`takePlaceWord`) — the model never guesses a place.
- **Digest** (`places.ts placeDigestOf`): open errands oldest first; `text` = `Safeway · 3 — shampoo, nails, syrup`
  (at most 12 titles, then `+N more`), `''` when empty so the Shortcut skips the banner. Settings' "Test" shows the
  same text.

## 3. The Places lens

A fifth bucket beside Today · Week · Backlog · Done (`query.ts placeOf`): an open, untimed, unplanned errand not
due this week lands in Places instead of Backlog; a dated or started errand still shows in Week/Today. Grouped by
place, one tap checks an item off (chained `in_progress → done` — `backlog → done` isn't an edge) with a few
seconds of "Add again", since done is terminal. `/tasks?lens=places&place=<slug>` (`placeLensPath`) focuses one
store — the notification's tap-through.

## 4. The Shortcut route

`GET /api/places/<slug>/tasks`, outside the RPC surface (like `/api/google/callback`).

- **Auth**: `x-aperture-authorization: Bearer apl_<32 random bytes, base64url>` — a **place token**, one per user,
  minted in Settings (shown once), stored only as its SHA-256 in a lookup row `placetoken#<hash>` that names the
  user. It rides the existing auth header because CloudFront forwards only that header on `/api/*` — a new
  header or a `?token=` would be stripped. A place token can't call any RPC method (not a JWT), and a JWT can't
  call this route (hash miss → 401). No local fallback: a missing or unknown token is always 401.
- **Answers**: 200 `PlaceRead`; 401 bad/missing token; 422 unknown place or path (only after auth); 405 non-GET;
  429 past `PLACE_READ_DAILY_CAP` (200 reads per token per UTC day — a hidden guard, not a user-facing cap); 500.
  **Never 404**: CloudFront turns any origin 403/404 into a 200 `index.html` for the whole distribution (the SPA
  fallback, `app-stack.ts`), so a 404 would reach the Shortcut as a web page. The path's slug is lowercased.
- **No silent failure**: every answer, errors included, carries a `text` the Shortcut shows ("Aperture: the
  Shortcut's token isn't valid — …", "Aperture: no place …"). Only an empty list is `''`, so the Shortcut's one
  rule is "show `text` if it has any value".
- **Token lifecycle**: the user's pointer `{hash | null, retiring[]}` is written with a condition on the version
  read, so a rotate racing a revoke on another device loses cleanly (it deletes its own new row and asks to try
  again). **The pointer is the authority**: every read also does a consistent GetItem of the user's pointer and
  401s unless its `hash` is this token's (round 2) — so a rotated-out or revoked token stops working the moment
  the pointer moves, even if deleting its lookup row failed. Old hashes sit in `retiring` only as cleanup, retried
  by the next rotate or revoke. Revoke leaves the pointer inactive (`hash: null`). A rotate that dies between creating the new lookup row and writing the pointer leaves an orphan row no pointer names: it can never authenticate, and nothing cleans it (harmless).
- **Writes** (200 only, through the handler's `writes`): the token row's daily read count + `lastUsedAt`, then the
  place's `lastReadAt` — Settings' "last called", the proof the automation fires. The heartbeat is best-effort: if
  it fails after the count landed, the failure is logged (`place_heartbeat_failed`) and the digest still returns.
- **Cost**: a read is 2 consistent GetItems (lookup + pointer) + 2 Queries + 2 PutItems; past the cap, 2 GetItems and
  nothing else. Not everything is capped: a missing/malformed header costs nothing, an unknown token 1 GetItem, and
  a 422 (unknown place or path, valid token) is never counted — 2 GetItems + a places Query each. A concurrent
  burst under the cap runs the full tasks Query before its conditional count write; the losers retry and can 500.
  So a leaked token scripted at 1 req/s for a month is a few dollars, almost all of it the Lambda/CloudFront request
  floor (the counter can't cap invocations without reserved concurrency, which would hurt the app); the Monitoring
  alarms are the tripwire, and revoking in Settings stops it at once. Realistic use is cents.
- **Privacy**: Aperture never receives a location. It does learn _when_ the Shortcut called (`lastReadAt`,
  `lastUsedAt`) — which roughly means when you arrived at that store. Your own data, in your own table.

## 5. Setting it up on the iPhone

Once (Settings › Places shows these with the URL and token filled in):

1. Settings › Places → add a place (e.g. Safeway) → **Generate token** → Copy.
2. Shortcuts → **+** → name it **Aperture list** → _Get Contents of URL_ `https://<app>/api/places/[Shortcut Input]/tasks`,
   Method GET, header `x-aperture-authorization` = `Bearer apl_…` → _Get Dictionary Value_ `text` → _If_ `text` has any
   value → _Show Notification_ `text` → _Otherwise_ → _If_ `count` does not have any value → _Show Notification_ "Aperture didn't
   answer" → _End If_ → _End If_. An empty list (`text` '', `count` 0) stays quiet; a non-answer (a CloudFront 5xx or
   throttle has no JSON body) doesn't.

Per store (about a minute each, only for stores you actually go to):

3. Automation → **+** → **Arrive** → pick the store → **Run Immediately**, **Notify When Run** off → _Run Shortcut_
   **Aperture list** with input `safeway`.

A second Safeway is another automation with the same input. Rotating the token means editing only the one
Shortcut. A place with no automation still works in the Places lens and through Claude ("what's on my Target
list?" → `list_place_tasks`).

## 6. Decision log

Answers from 2026-11-03 (branch `localNotes/decisions.md` has the full log).

- **D1 Errands per store via an Arrive automation**, not Web Push geofencing (a PWA has none), not mirroring into
  Apple Reminders, not a native shell. Phone test 2026-11-03: an iOS 26 Arrive automation set to Run Immediately
  ran _Get Contents of URL_ → _Show Notification_ with **no confirmation tap**; iOS adds its own "automation ran"
  banner unless Notify When Run is off.
- **D2 The task stores the slug**, not the place id — the slug is what `@slug`, the URL and the lens use.
- **D3 Errands never count in calibration** — `place` set ⇒ excluded, by the one shared predicate. So a finished
  task's place is history (round 1, 2026-11-04): `setTaskPlace` refuses a done/cancelled task, and deleting a place
  "off any list" leaves finished errands on the old slug — otherwise clearing it would turn a checked-off errand
  (estimate locked, actual 0) into a calibration point. Moving to another place or renaming still rewrites them.
- **D4 Places is a lens bucket**, not a Backlog filter: an errand is in exactly one lens.
- **D5 One-tap check-off with "Add again"**, not a confirm step.
- **D6 Deleting a place asks where its tasks go** (another place or none), like deleting a category.
- **D7 No default place.** You add your own; Settings starts empty.
- **D8 The token is a hashed lookup row, user-rotated**, not an env secret like the device token — so the dev
  check's test user can prove the route end to end.
- **D9 200 reads/token/day, hidden.** The user rejected a user-facing push cap; this one only bounds a leaked
  token's cost.
- **D10 One generic Shortcut + tiny per-store automations**, so a token rotation edits one Shortcut.

## 7. Build record

_Filled in at the end of the build._
