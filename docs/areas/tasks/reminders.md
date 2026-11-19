# Reminders (Web Push to the installed PWA)

**Area:** tasks · **Branch:** `timed-reminders`

**Status: building 2026-11-04.** PR 2 of the reminders feature (prod task "Reminders + notifications"; PR 1 was
[places](places.md), PR 3 the morning/night ritual nudges). Plan, research and the full decision log: the branch's
`localNotes/` (archived with the branch). **2026-11-18, branch `reminders-retry-nudges`:** PR 3 — the ritual
nudges — and the retry of transient send failures with a one-time catch-up (D17–D24).

Permanent design-of-record: §6 is the decision log, §7 the build record. Where this doc and the code disagree,
fix whichever is wrong and say so here.

---

## 1. Why

A deadline only helps if it reaches me when it matters. Aperture lives in an installed PWA (Safari, iPhone first),
so the ping is a Web Push notification. No native app, and no Google Calendar dependency beyond a popup on
timed events.

## 2. Shape

Five kinds, one rule per kind (`packages/shared/src/reminders.ts`), each with its own toggle in Settings ›
Notifications:

| Kind            | When it pings                                 | Toggle          |
| --------------- | --------------------------------------------- | --------------- |
| `timed`         | a task's `dueDay` + `dueTime`, at that minute | `remindTimed`   |
| `dueDay`        | a day-only deadline, at 09:00 that day        | `remindDueDay`  |
| `planned`       | a task on a day's plan, at 09:00 that day     | `remindPlanned` |
| `ritualMorning` | "Plan your day", 08:30 every day              | `nudgeMorning`  |
| `ritualNight`   | "Close the day", 21:30 every day              | `nudgeNight`    |

- Times are the user's zone (`userDueEpoch`), DST-safe. Only open tasks ping: not done, not cancelled, not
  tombstoned. Errands and parts ping like any task.
- A task that is both day-only due and planned on the same day pings once (due wins). A series deadline
  occurrence planned on its due day gets both: the 09:00 planned ping and its deadline minute.
- **Armed before it fires.** A reminder pings only if it was set before its fire time. A task created or
  re-dated after its fire time stays quiet, and so does a plan made after 09:00 for that day (the 09:00–09:30
  planning case). So does anything that fell due while its kind's toggle was off, or before the user's first
  device. The 30-minute window still catches up a reminder that existed in time and was missed by a failed
  tick. Send test is exempt. How it's checked: §3.
  - **Reopening:** done and cancelled are terminal (`machines.ts`), so no BFF path reopens a task, and a
    finished task's plans can't fire again. If a reopen path is ever added, the task re-arms on its own write,
    and that path must re-arm the task's plans too (`backend.push.test.ts` pins the terminal states).
  - **Series:** a series' task and plan for a day are created on that day's first `getDay`
    ([recurring.md](recurring.md) §2), so a first open after 09:00 means that plan was made after its fire
    time — no planned ping that day. An occurrence due later (`dueOffsetDays`) still pings at 09:00 on its
    due day: that deadline was set before it fires — or, with a series due time, at that minute (`timed`).
    A timed occurrence due after its day is planned on that day like an untimed task, so it also gets the
    `planned` ping there (`timeDecidesDay`, recurring.md D8); any other timed task never does.
- There is no user-facing cap and no quiet hours (both rejected).
- **Ritual nudges** (`RITUAL_TIMES`, `push/rituals.ts`): counts only, never "missed" — morning "4 planned
  today" or "Nothing planned yet"; night "3 left open · 2 done" (either half alone) or "Nothing on today's
  plan". The counts are the day's plan as the app reads it (each plan's newest copy, its task not cancelled,
  and not one whose time decides its day — a series deadline occurrence counts).
  Each nudge is its own notification, tagged by its kind, and opens Home (`/`), whose clock mode is already
  morning at 08:30 and night at 21:30 — for a day that starts by 08:30 (`dayStartHour` ≤ 8; the default is 4).
  Its day is the calendar day of its fire time. Armed like any kind (the toggle's switch-on time, the registry row). No
  auto-mute (the maintainer, 2026-11-18). A nudge is never caught up: one the window misses is gone.
- **Same-tick batching:** several reminders in one minute become one notification ("3 reminders", titles joined).
- **Tap-through:** `/tasks?lens=today&task=<id>&n=<tag>` opens the task's modal on Today. A batch opens Today.
  `n` is the notification tag (nothing reads it: PR 3 dropped the auto-mute it was kept for). The tap also
  clears a sticky Tasks search (`useTaskQuery`), so closing the modal lands on Today.

```
Settings › Enable ──subscribePush──▶ BFF ── u#<uid> pushsub#<id> + push/user#<uid>
                                                     │
EventBridge Scheduler, once a minute ──▶ aperture-push-dispatch-<stage>
   for each registered user: GSI1 u#<uid>#remind, fireAt ∈ [now−30 min, now]
   → re-read task · toggle · dedup psent# · guard pcount# · encrypt · POST to the push service
                                                     │
                                         Apple/FCM ──▶ device banner (declarative, no SW handler)
```

## 3. Delivery

- **Declarative Web Push** (Safari 18.4+/iOS 26): the payload is
  `{"web_push":8030,"notification":{title, body, navigate, tag, …}}` and the system shows it as-is. The
  Workbox-generated service worker has no `push` handler, so the declarative fallback always displays. The app
  subscribes via `window.pushManager` (Safari), falling back to the service worker registration's.
- **The poller** is a once-a-minute Scheduler Lambda, `cron(* * * * ? *)` (`cdk/src/lib/push-dispatch.ts`,
  cloned from finance-sync). Scheduler doesn't fire at :00: its precision is 60 s, rate or cron, and each schedule
  keeps its own second (dev's ticks started at :37, measured 2026-11-08 after a switch from `rate(1 minute)` that
  was meant to align them and didn't). So a reminder goes out up to ~60 s after its minute. Task data is the truth; there are no per-reminder schedules to drift. A tick does the following:
  1. Lists the user registry (`PK=push`, `SK=user#<uid>`, written on first subscribe).
  2. Queries GSI1's third key space for each user: `GSI1PK=u#<uid>#remind`, `GSI1SK=fireAt`, set on task and
     plan items atomically with their write.
  3. Re-reads each task (or plan) consistently. A plan pings only from its newest copy: a move writes the new
     key before deleting the old one (`putPlan`), so the old copy outlives it by a write, or for good when that
     delete failed. One consistent range read from the window's earliest plan day finds each plan's newest
     copy, as the app's reads do. A removal's tombstone, or a newest copy dated before that day, reads as
     absent, so the row stays quiet.
  4. Applies the toggles and the arm rule (below).
  5. Writes the dedup row `psent#<fireAt>#<taskId>` with `putIf` **before** sending.
  6. Bumps the daily guard `pcount#<day>`.
  7. Sends.
  8. Writes the heartbeat `push/health`.
- **The arm rule** (§2, "armed before it fires"). A candidate is skipped when any of these is later than its
  fire time:
  - the row's `remindArmedAt`: when its current fire time was set. It's a table-only attribute beside the GSI
    keys, never on the entity, an API answer or the export. A write keeps the stored value while the row was
    already on the remind index at the same fire time (a rename, an estimate, a reorder within the day), and
    otherwise stamps the write's `updatedAt`: created, re-dated, or planned on a new day. Deciding
    this costs one consistent read before writing a task or plan that can fire. `createdAt` alone would miss a
    re-date or a reopen; `updatedAt` alone would silence a missed reminder whose title was edited.
  - the kind's switch-on time (`u#<uid>/pusharm`, written when a toggle goes from off to on);
  - the registry row's `createdAt`: when the user's first device turned reminders on. The backfill that runs
    then arms what it re-keys at its own time, too.
- **The registry can't lose a user.** A subscribe writes its device before it checks the registry. Every
  removal of the user's row (the last device removed, or deleted by the poller after a 404/410) then re-reads
  their devices strongly and puts the row back, keeping its `createdAt`, if one is alive. `getPushStatus` also
  re-adds it when a live device exists. The poller's 404/410 delete is conditional on the version it read, so a
  removal (tombstone) or a re-subscribe that lands mid-send stands. That 404 counts as a transient failure
  ("re-subscribed mid-send"): a fresh notification or a retry short of its last is retried (the last runs out
  to the catch-up), and a catch-up's failure is said on the device and the health line. A device's id is its
  endpoint's hash, so the re-subscribe re-sent the same endpoint — typically the app's launch resync — and the
  retry most likely 404s again and deletes it a tick later: at most 1 + `RETRY_MAX` + 1 POSTs a notification,
  each needing another racing write.
- **Fail-closed dedup:** dedup and guard rows are written before the send and never refunded, so no reminder
  is ever found twice.
- **Retry and catch-up** (`push/deliver.ts`, D17–D22). Each device's answer is classified:
  - delivered (2xx); gone (404, 410, unusable keys — the device is dropped, as before);
  - **transient** — a timeout, a network failure, 429, 500, 503 (RFC 8030, Apple's and FCM's status
    tables; a 429's `Retry-After` isn't read — the next tick is the retry), and 502/504, a gateway's fault of
    the same kind (inference): a retry row `pq#r#<subId>#<topic>` holds the notification's candidates, and the next
    `RETRY_MAX` = 3 ticks retry that device only, under the same Topic, so a first copy the service took but
    never answered for is replaced while still undelivered (RFC 8030 §5.4). The device reads "… — retrying".
    Each retry re-reads its tasks: one finished, deleted, re-dated or taken off that day's plan since stays
    quiet, as does a planned one given a time that decides its day (`plannable`, the planned ping's own test
    — a series deadline occurrence still goes). Retries take no guard unit. Each try is claimed (counted, on the version read) before its POST. A
    device the tick's deadline skipped gets a retry row too, with no try spent. A slow device — its last
    attempt failed, or (slower still) a retry of it has a try spent — goes last in a fresh batch, its retries
    after the rest's and its catch-up after theirs, so one that keeps timing out (10 s) can't use up a tick before the others within one sender; a
    fresh batch still goes before earlier ticks' retries, and retries before catch-ups, so a slow device's
    retry can hold the others' catch-ups up to 4 ticks (nothing is lost — misses keep 12 h), and a skipped device's older retry can wait a tick more
    (within the 5-minute expiry). A new failure under a Topic still retrying replaces that row;
  - final — anything else (400, 403, 413, a fault of ours): the device's error, as before.

  Retries that run out (or a retry older than 5 minutes: the poller stalled) leave the device "… after N
  tries" and its reminders as misses, `pq#m#<subId>#<fireAt>#<key>`. **A poller gap** — no tick the stage
  could check (the poller's `lastCheckedAt`: it could sign, read the registry and start a user's tick, or had
  none) for longer than the window — leaves misses too, for every device: what fell due in it, up to 12 h back, armed, enabled
  and still open, deduped by its `psent#` row and queued before any send of that tick. A device's misses go out once, as "N reminders didn't reach you" with their
  titles (opening Today), when all of them have settled (5 minutes after a run-out; at once after a gap) and
  no retry is pending for it. The rows are claimed before the guard and the send; each device's catch-up is its
  own notification against the guard (one refused is dropped and said, as a reminder past the guard is),
  tried once, its failure on the device and the health line; one that lands clears the device's error like
  any delivery. Tests and nudges are never missed. The gap pass runs on the one tick that
  reads the old cursor; a user that tick doesn't finish (their own tick throws, or the deadline stops the loop
  before them) loses that gap's catch-up, and a user whose tick keeps throwing past the window loses what fell
  due meanwhile. That is the trade the maintainer chose (2026-11-18) over holding the cursor for every user;
  a throwing tick fires prod's Errors alarm (dev has none), a deadline skip only logs `push_deadline`. Queue rows of a device removed later are swept by the
  user's next tick; a user who leaves the registry leaves them behind, small and inert.
  A rare duplicate is possible: a timed-out POST the service accepted and delivered before its retry arrived
  shows twice (iOS doesn't replace by tag — WebKit bug 258922); a missed deadline was judged worse.

- **Hidden guard:** 50 notifications (batches, each nudge and each catch-up — not device POSTs or retries) per
  user per LA day. Past it the poller
  refuses and stamps the health error.
- **Stage faults** are checked before anything is consumed: no `APP_URL` (the VAPID `sub`), no VAPID private
  key ("No VAPID key on this stage") or one that isn't a 32-octet P-256 key ("VAPID private key is malformed").
  Both SSM values are trimmed on read. The poller logs it once per
  container, writes it on the heartbeat, and sends nothing. A malformed key is never cached, so a fixed
  parameter works on the next tick.
- **Crypto is hand-rolled** in `node:crypto` (`lambdas/src/push/webpush.ts`): VAPID ES256 (RFC 8292) and
  aes128gcm (RFC 8291), pinned by RFC 8291 Appendix A's test vector. `web-push` (3.6.7, last published
  2024-01) stays a fallback only if Apple rejects output that passes the vector.
- Send headers: `TTL: 3600`, `Urgency: high`, `Topic: <tag>`.

## 4. Visible health

Settings › Notifications shows:

- this device's permission and subscription state;
- each device with its last delivery or last error;
- the poller's last run ("Reminders paused since …" past 5 minutes);
- the last send and error. "Last sent" (`poller.lastSentAt`) is the last time a push service **accepted** a
  notification for the user; a refusal moves only the error. The error names every device that refused in that
  tick, joined by " · ". The stage's current fault outranks the user's last error.

**Send test** queues a `ptest#` row in the remind key space. The poller sends it on the next tick, so the test
proves the whole chain. The BFF never holds the private key.

**Re-subscribe on launch** (`usePushSync` → `browserPush.ts` `resyncHere`, http mode, permission granted):

- **Healing.** The subscription is gone, was made with a different VAPID key, or the server no longer lists
  this device. The last case is the poller's hard delete after a 404/410 or keys it couldn't use. The app
  then drops that dead endpoint and subscribes fresh, never re-sending the old one, and upserts the device.
- **Retiring the old row.** When the server lists the fresh subscription under a new id (a new endpoint),
  the app tombstones its own old row. It records the new id first, so the tombstone doesn't read as a
  removal from another device. Otherwise the old row would sit live as a twin the poller 410s and reports as
  "stopped accepting". A retire that fails is retried on a later launch.
- **Removal sticks** (the maintainer). A device removed in Settings on another device is a tombstone, listed in
  `removedDeviceIds`. When a status read finds this device's id there, the app drops its opt-in and its
  browser subscription and writes nothing to the server. Settings then shows a one-time note worded for
  what this browser can do next: tap Enable, allow notifications first, open the Home Screen app, or
  nothing works here. The note stays until Enable or Dismiss. A launch never re-adds a removed device. So
  that tombstone never expires, not even on dev's TTL table (`expiresAtOf` in `writes.ts` exempts `pushsub#`).
- **Home banner.** A failed resync is remembered on the device. Home shows "Reminders couldn't refresh on
  this device — open Settings", with Dismiss. A dismissal holds until a new failure, and the next healthy
  launch clears it.

## 5. Security and cost

- **SSRF:** `subscribePush` admits only https endpoints on `PUSH_ENDPOINT_HOSTS` (Apple, FCM, Mozilla, WNS)
  with no credentials or port. The poller POSTs only to stored endpoints, with a 10 s timeout (FCM asks for at
  least 10 s) and no redirects; no send starts in a tick's last 12 s (`TICK_SAFETY_MS`).
- **Credentials:**
  - A subscription's endpoint, `p256dh` and `auth` let anyone push to the device. They are never in
    `exportData`, `getPushStatus`, logs or the dev-check ledger.
  - The VAPID private key lives in SSM `/aperture/<stage>/push/vapid_private_key` (SecureString) and is read by
    the poller's role only.
  - The public key is in `vapid_public_key` (String) and is read by the BFF only.
- **Logs:** one JSON line per send, error or skip: `push_sent`, `push_failed`, `push_guard_tripped`,
  `push_deadline` (the tick ran out of time), `push_retry_exhausted` (a device's retries ran out),
  `push_user_dropped` (a user with no live device left the registry), and the once-per-container stage faults `push_no_key`, `push_bad_key`, `push_no_app_url`. A send
  line carries the status, the task ids and a sub-id prefix — never the endpoint, the keys or the title.
- **Cost bound:**
  - Steady state is about 43 k invocations a month at about 0.3 s, roughly **$0.04/mo**, all inside the free
    tiers. A tick reads a user's send queue, dedup and Send-test rows in one consistent range Query (`pq#` …
    `ptest#`, which sort together — `keys.test.ts` pins it), reads the health row only when it writes it, and
    sweeps guard counters every 10 minutes: fewer requests than before the queue existed (2026-11-18: 3 Queries
    and 2 Gets per user per quiet tick, against 5 and 2). In read units that holds while the 48 h of dedup rows
    stay under ~8 KB (the range is a consistent read; the sweep's `psent#` read wasn't), past which it's under a
    cent a month more. The gap pass re-runs only while the heartbeat itself doesn't land (a tick killed before
    its poller write) — its candidates already deduped, so only reads and refused conditional puts, inside the
    stuck-tick bound below. Users are taken in an order rotated each
    minute, so one whose device keeps timing out can't delay the others every tick. The nudges add a plan read twice a day. A quiet tick writes no log line of its own; Lambda's START/END/REPORT lines come to about 17 MB a month
    per stage, against CloudWatch's free 5 GB.
  - Worst case is a tick stuck at the 20 s timeout every minute: 1,440 × 20 s × 0.25 GB = 7,200 GB-s, about
    **$0.12/day of compute**, about $0.15/day with DynamoDB and logs, with pushes capped by the guard.
  - On prod, reserved concurrency 1. There is no alarm of its own, because a rule says no fixed monthly cost: the
    account-wide Lambda Errors alarm emails on a failing tick, and a stuck tick's 20 s timeout counts as an error.
  - On dev, reserved concurrency 1 too, part of dev's compute cap (`cdk/src/config/devAccount.ts`). Timeout < rate
    keeps ticks from overlapping, and the hourly kill alarm trips a stalled poller.

## 6. Setup and rotation

- Keys (once per stage, from the Mac): `pnpm vapid-keys` prints the public key, then the private one, each
  piped into `aws ssm put-parameter`. The exact one-liners are in the branch plan's _Operator steps_. Without
  them the poller logs `push_no_key` and Settings says "Reminders aren't set up on this stage".
- **Rotation** (rare, deliberate):
  1. Put both parameters with `--overwrite`.
  2. Every existing subscription then fails. On a 404/410 the poller deletes it, and Settings says to turn
     reminders on again on that device. On a 403 it keeps the device, marked "Last reminder didn't reach this
     device (push service answered 403)", and drops its cached key.
  3. The phone heals on its next launch (`usePushSync`).
- **Dev deploys** of this stack's new function, roles and schedule need the dev freeze opened for the dispatch
  (`docs/ops/CI-BOT.md` → _Kill switch_ → _Opening the freeze_).

## 7. Decision log

Answers from 2026-11-03/04 (the branch `localNotes/decisions.md` has the full log).

- **D1 Three kinds, one fire-time function each,** with a toggle per kind.
- **D2 A 1-minute poller, not per-reminder schedules.** The maintainer questioned it; it was kept, because one-shot
  schedules would have to stay in sync across every task write path, the BFF would need scheduler IAM plus the
  dev freeze, and a failed schedule is lost. An always-on server costs about $5–15/mo plus ops.
- **D3 Dedup and the guard are written before the send** (fail-closed).
- **D4 Same-tick batching.**
- **D5 One subscription per endpoint**; its id is a `sha256(endpoint)` prefix, so re-subscribing is an upsert.
- **D6 Health is visible**, and Send test goes through the poller.
- **D7 Re-subscribe on launch.**
- **D8 Tap-through to the task modal.** Whether iOS opens the installed PWA rather than Safari is
  **unverified** and is a device test.
- **D9 Google Calendar popup at event start** on every timed task's event. It is always on, with no toggle
  (revisit if it proves intrusive).
- **D10 PR 3 slots in as another candidate source** (ritual nudges): no rework of send, dedup, guard or health.
- **D11 No dependencies.**
- **D12 Keys in SSM, treated as permanent.**
- **D13 VAPID `sub` = the app URL.**
- **D14 `Urgency: high`** for every kind.
- **D15 Endpoint allowlist** (SSRF).
- **D16 No model call in the send path.**
- **D17 Retry transient failures** (timeouts, network failures, 429, 5xx) on the next 3 ticks, same Topic,
  deduped; 404/410 stay final; 400/403/413 final too (the maintainer's 6.1, 2026-11-18; statuses from RFC 8030,
  Apple's and FCM's docs).
- **D18 One "N reminders didn't reach you" catch-up** per device after retries run out or a poller gap (6.1).
- **D19 The 30-minute window stays** (6.2): a longer one would fire a task re-dated into the past at once.
- **D20 A run-out miss stays visible** on the device and the health line (6.3) — and the catch-up says it too.
- **D21 Send timeout 5 → 10 s** (FCM's minimum): fewer slow-but-accepted sends turn into retries.
- **D22 Guard counts notifications:** retries free, a catch-up one unit.
- **D23 Ritual nudges** at 08:30 and 21:30, counts only, each toggle on by default, no auto-mute (16.1 as
  amended, 2026-11-18); each its own notification, opening Home.
- **D24 A tap clears a sticky Tasks search** (the maintainer's yes, 2026-11-18).
- **Deferred:**
  - per-task "remind me at";
  - `app_badge`;
  - a longer catch-up window (D19).

## 8. Build record

_Filled in at the end of the build._
