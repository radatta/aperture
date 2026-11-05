# Reminders (Web Push to the installed PWA)

**Area:** tasks · **Branch:** `timed-reminders`

**Status: building 2026-11-04.** PR 2 of the reminders feature (prod task "Reminders + notifications"; PR 1 was
[places](places.md), PR 3 the morning/night ritual nudges). Plan, research and the full decision log: the branch's
`localNotes/` (archived with the branch).

Permanent design-of-record: §6 is the decision log, §7 the build record. Where this doc and the code disagree,
fix whichever is wrong and say so here.

---

## 1. Why

A deadline only helps if it reaches me when it matters. Aperture lives in an installed PWA (Safari, iPhone first),
so the ping is a Web Push notification. No native app, and no Google Calendar dependency beyond a popup on
timed events.

## 2. Shape

Three kinds, one rule per kind (`packages/shared/src/reminders.ts`), each with its own toggle in Settings ›
Notifications:

| Kind      | When it pings                                 | Toggle          |
| --------- | --------------------------------------------- | --------------- |
| `timed`   | a task's `dueDay` + `dueTime`, at that minute | `remindTimed`   |
| `dueDay`  | a day-only deadline, at 09:00 that day        | `remindDueDay`  |
| `planned` | a task on a day's plan, at 09:00 that day     | `remindPlanned` |

- Times are the user's zone (`userDueEpoch`), DST-safe. Only open tasks ping: not done, not cancelled, not
  tombstoned. Errands and parts ping like any task.
- A task that is both due and planned on the same day pings once (due wins).
- There is no user-facing cap and no quiet hours (both rejected).
- **Same-tick batching:** several reminders in one minute become one notification ("3 reminders", titles joined).
- **Tap-through:** `/tasks?lens=today&task=<id>&n=<tag>` opens the task's modal on Today. A batch opens Today.
  `n` is the notification tag, kept for PR 3's "opened" signal.

```
Settings › Enable ──subscribePush──▶ BFF ── u#<uid> pushsub#<id> + push/user#<uid>
                                                     │
EventBridge Scheduler rate(1 min) ──▶ aperture-push-dispatch-<stage>
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
- **The poller** is a `rate(1 minute)` Scheduler Lambda (`cdk/src/lib/push-dispatch.ts`, cloned from
  finance-sync). Task data is the truth; there are no per-reminder schedules to drift. A tick does the following:
  1. Lists the user registry (`PK=push`, `SK=user#<uid>`, written on first subscribe).
  2. Queries GSI1's third key space for each user: `GSI1PK=u#<uid>#remind`, `GSI1SK=fireAt`, set on task and
     plan items atomically with their write.
  3. Re-reads each task consistently.
  4. Applies the toggles.
  5. Writes the dedup row `psent#<fireAt>#<taskId>` with `putIf` **before** sending.
  6. Bumps the daily guard `pcount#<day>`.
  7. Sends.
  8. Writes the heartbeat `push/health`.
- **Fail-closed:** dedup and guard rows are written before the send and never refunded. A transient push-service
  error loses that one ping (logged, and shown in Settings) rather than risking a double ping. A reminder older
  than the 30-minute window is missed, never fired late. Retrying is a logged follow-up (prod task
  `01M6MXRGEDXWQG5E1T5X95YM1Q`).
- **Hidden guard:** 50 sends per user per day. Past it the poller refuses and stamps the health error.
- **Crypto is hand-rolled** in `node:crypto` (`lambdas/src/push/webpush.ts`): VAPID ES256 (RFC 8292) and
  aes128gcm (RFC 8291), pinned by RFC 8291 Appendix A's test vector. `web-push` (3.6.7, last published
  2024-01) stays a fallback only if Apple rejects output that passes the vector.
- Send headers: `TTL: 3600`, `Urgency: high`, `Topic: <tag>`.

## 4. Visible health

Settings › Notifications shows:

- this device's permission and subscription state;
- each device with its last delivery or last error;
- the poller's last run ("Reminders paused since …" past 5 minutes);
- the last send and error.

**Send test** queues a `ptest#` row in the remind key space. The poller sends it on the next tick, so the test
proves the whole chain. The BFF never holds the private key.

Re-subscribe on launch (`usePushSync`): if permission is granted but the subscription is gone or was made with a
different VAPID key, the app re-subscribes silently.

## 5. Security and cost

- **SSRF:** `subscribePush` admits only https endpoints on `PUSH_ENDPOINT_HOSTS` (Apple, FCM, Mozilla, WNS)
  with no credentials or port. The poller POSTs only to stored endpoints, with a 5 s timeout and no redirects.
- **Credentials:**
  - A subscription's endpoint, `p256dh` and `auth` let anyone push to the device. They are never in
    `exportData`, `getPushStatus`, logs or the dev-check ledger.
  - The VAPID private key lives in SSM `/aperture/<stage>/push/vapid_private_key` (SecureString) and is read by
    the poller's role only.
  - The public key is in `vapid_public_key` (String) and is read by the BFF only.
- **Logs:** one JSON line per send or error (`push_sent | push_failed | push_guard_tripped | push_no_key`). Each
  line carries the status, the task id and a sub-id prefix — never the endpoint, the keys or the title.
- **Cost bound:**
  - Steady state is about 43 k invocations a month at about 0.3 s, roughly **$0.04/mo**.
  - Worst case is a tick stuck at the 20 s timeout every minute: about $0.15/day, with pushes capped by the
    guard.
  - On prod, reserved concurrency 1 plus the Errors/Duration alarms email within 5 minutes.
  - On dev, reservations are impossible (quota 10, and the SCP denies it). Timeout < rate keeps ticks from
    overlapping, and the hourly kill alarm trips a stalled poller.

## 6. Setup and rotation

- Keys (once per stage, from the Mac): `pnpm vapid-keys` prints the public key, then the private one, each
  piped into `aws ssm put-parameter`. The exact one-liners are in the branch plan's _Operator steps_. Without
  them the poller logs `push_no_key` and Settings says "Reminders aren't set up on this stage".
- **Rotation** (rare, deliberate):
  1. Put both parameters with `--overwrite`.
  2. Every existing subscription then fails with 403/410. The poller deletes them and Settings says to
     re-enable.
  3. The phone heals on its next launch (`usePushSync`).
- **Dev deploys** of this stack's new function, roles and schedule need the dev freeze opened for the dispatch
  (`docs/ops/CI-BOT.md` → _Kill switch_ → _Opening the freeze_).

## 7. Decision log

Answers from 2026-11-03/04 (the branch `localNotes/decisions.md` has the full log).

- **D1 Three kinds, one fire-time function each,** with a toggle per kind.
- **D2 A 1-minute poller, not per-reminder schedules.** Rahul questioned it; it was kept, because one-shot
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
  ("if it's annoying we can change it later").
- **D10 PR 3 slots in as another candidate source** (ritual nudges): no rework of send, dedup, guard or health.
- **D11 No dependencies.**
- **D12 Keys in SSM, treated as permanent.**
- **D13 VAPID `sub` = the app URL.**
- **D14 `Urgency: high`** for every kind.
- **D15 Endpoint allowlist** (SSRF).
- **D16 No model call in the send path.**
- **Deferred:**
  - per-task "remind me at";
  - `app_badge`;
  - retrying transient send failures, a longer catch-up window, or a "missed N" ping (prod task above).

## 8. Build record

_Filled in at the end of the build._
