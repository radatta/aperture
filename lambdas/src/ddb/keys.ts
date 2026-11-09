// Single-table key layout (TECH §2.4). One partition per user; type-prefixed range keys so a
// begins_with Query pulls exactly one entity kind. Nothing here talks to DynamoDB — pure string math,
// so it's trivially testable and shared by the in-memory and the real DocClient alike.
//
// The one partition that is NOT a user's: `placetoken#<sha256hex> / placetoken`, the Shortcut token's
// lookup row (places.md). The Shortcut route holds only the token, so the row has to be findable by its
// hash before any userId is known — it carries the userId instead. Never read by a user's queries
// (they all start `u#`), never exported.
//
// The second: `push`, the reminder poller's (reminders.md). `user#<uid>` lists who has a device to ping
// (written on the first subscribe, removed with the last unsubscribe — the poller runs per user without a
// fixed user id), and `health` is the poller's heartbeat. Derived, never client-set, never exported.

export const pk = (userId: string) => `u#${userId}`;
export const placeTokenPk = (hash: string) => `placetoken#${hash}`;
export const PLACE_TOKEN_SK = 'placetoken';
export const PUSH_PK = 'push';
export const pushSk = {
  user: (userId: string) => `user#${userId}`,
  userPrefix: () => `user#`,
  health: () => `health`,
} as const;

// Plan order and GSI completion time are numbers we sort lexically inside the SK — pad to fixed width.
const padOrder = (order: number) => String(Math.max(0, Math.trunc(order))).padStart(6, '0');
// An epoch ms inside an SK: 13 digits covers every date until 2286, so lexical order is numeric order.
const padEpoch = (ms: number) => String(Math.max(0, Math.trunc(ms))).padStart(13, '0');

export const sk = {
  log: (day: string, id: string) => `log#${day}#${id}`,
  logPrefix: (day: string) => `log#${day}#`,
  logAllPrefix: () => `log#`,

  // LeetCode attempts (retired: the legacy ingest still writes, nothing reads), day-bucketed like log.
  // Dedup-by-submission-id is a prefix scan.
  lc: (day: string, id: string) => `lc#${day}#${id}`,
  lcPrefix: (day: string) => `lc#${day}#`,
  lcAllPrefix: () => `lc#`,

  // LeetCode sittings (docs/areas/recruiting). The head is `lcsit#<id>` (id = the Start's clientSittingId,
  // so a double-fired Start can't make two); its children sit under `lcs#<id>#` — the live row, the capture
  // budget, head rows (`hd#`: a run's, submit's, note's or timer read's verdict — compact; the summary is
  // recomputed from them), those events' full payloads (`jd#`, kept forever), raw bulk events (`ev#`:
  // snapshots, submit details) and replay chunks (`rp#`), each its own begins_with and each
  // keyed by its client-minted ULID, so a repeat is a repeat whatever its time. `lcs#` never matches `lcsit#`,
  // and neither matches the legacy `lc#`. The problem doc is one row per slug, shared by its sittings.
  sitting: (id: string) => `lcsit#${id}`,
  sittingPrefix: () => `lcsit#`,
  sittingChildPrefix: (id: string) => `lcs#${id}#`,
  sittingChildAllPrefix: () => `lcs#`,
  sittingLive: (id: string) => `lcs#${id}#live`,
  sittingBudget: (id: string) => `lcs#${id}#budget`,
  sittingHeadRow: (id: string, eventId: string) => `lcs#${id}#hd#${eventId}`,
  sittingHeadRowPrefix: (id: string) => `lcs#${id}#hd#`,
  sittingJudged: (id: string, eventId: string) => `lcs#${id}#jd#${eventId}`,
  sittingJudgedPrefix: (id: string) => `lcs#${id}#jd#`,
  sittingEvent: (id: string, eventId: string) => `lcs#${id}#ev#${eventId}`,
  sittingEventPrefix: (id: string) => `lcs#${id}#ev#`,
  sittingReplay: (id: string, chunkId: string) => `lcs#${id}#rp#${chunkId}`,
  sittingReplayPrefix: (id: string) => `lcs#${id}#rp#`,
  lcProblem: (slug: string) => `lcq#${slug}`,
  lcProblemPrefix: () => `lcq#`,
  // The user's Start gate (one row): today's Start attempts and Starts, and the open sitting it let through —
  // the single decision point that keeps parallel Starts to one open sitting and the daily caps.
  lcStart: () => `lcstart`,

  // Flux sets (D47), day-bucketed like lc. A few rows a day: reads and the by-id lookup scan `flux#`.
  flux: (day: string, id: string) => `flux#${day}#${id}`,
  fluxAllPrefix: () => `flux#`,
  // The weekly note (D62): one row per ISO week, rebuilt when the week's sets change.
  fluxNote: (weekStart: string) => `fluxnote#${weekStart}`,

  task: (id: string) => `task#${id}`,
  taskPrefix: () => `task#`,

  plan: (day: string, order: number, id: string) => `plan#${day}#${padOrder(order)}#${id}`,
  planPrefix: (day: string) => `plan#${day}#`,
  planAllPrefix: () => `plan#`,

  // Running timers live under a dedicated prefix so the pomodoro heartbeat is a direct GetItem and the
  // running set is a tiny scan; on stop a session moves to its day bucket for history. `sess#` spans both.
  sessionRunning: (id: string) => `sess#running#${id}`,
  sessionRunningPrefix: () => `sess#running#`,
  session: (day: string, id: string) => `sess#${day}#${id}`,
  sessionDayPrefix: (day: string) => `sess#${day}#`,
  sessionPrefix: () => `sess#`,

  hcheck: (date: string, habitId: string) => `hcheck#${date}#${habitId}`,
  hcheckPrefix: (date: string) => `hcheck#${date}#`,
  hcheckAllPrefix: () => `hcheck#`,

  day: (date: string) => `day#${date}`,
  dayPrefix: () => `day#`,

  habit: (id: string) => `habit#${id}`,
  habitPrefix: () => `habit#`,

  // Rolls — id-keyed like habits/series; list is a `roll#` begins-with scan (tiny N). Reps are DERIVED
  // from tasks carrying rollId (no roll-owned check rows), so there's no per-day child prefix here.
  roll: (id: string) => `roll#${id}`,
  rollPrefix: () => `roll#`,

  cat: (id: string) => `cat#${id}`,
  catPrefix: () => `cat#`,

  // Places (errand lists) — id-keyed, a `place#` begins-with list (tiny N; slug unique per user). The
  // token pointer is a singleton: which lookup row is this user's live token, and which old ones are still
  // to delete (rotate/revoke find them through it). A credential's pointer — never exported.
  place: (id: string) => `place#${id}`,
  placePrefix: () => `place#`,
  ptoken: () => `ptoken`,

  idea: (id: string) => `idea#${id}`,
  ideaPrefix: () => `idea#`,

  series: (id: string) => `series#${id}`,
  seriesPrefix: () => `series#`,

  // Behavioral story bank — a plain id-keyed entity; list is a `story#` begins-with scan (tiny N).
  story: (id: string) => `story#${id}`,
  storyPrefix: () => `story#`,

  // Task attachments — grouped by task so a card's files are one begins-with query; ULIDs sort by
  // upload time within a task. `attach#` spans all tasks (export, find-by-id, task-delete cascade).
  attach: (taskId: string, id: string) => `attach#${taskId}#${id}`,
  attachTaskPrefix: (taskId: string) => `attach#${taskId}#`,
  attachAllPrefix: () => `attach#`,

  settings: () => `settings`,

  // Reminders (reminders.md). A device's Web Push subscription, by a sha256(endpoint) prefix — it carries
  // the device's keys, a credential, so it's never exported or returned. The rest are the poller's:
  // `psent` dedup rows (one per reminder sent, written before the send, swept after 48 h), the hidden daily
  // guard's counter per LA day, Settings' Send-test candidates (on the remind index at their queue time),
  // and the user's last send / error.
  pushSub: (id: string) => `pushsub#${id}`,
  pushSubPrefix: () => `pushsub#`,
  pushSent: (fireAt: number, key: string) => `psent#${padEpoch(fireAt)}#${key}`,
  pushSentPrefix: () => `psent#`,
  pushCount: (day: string) => `pcount#${day}`,
  pushCountPrefix: () => `pcount#`,
  pushTest: (id: string) => `ptest#${id}`,
  pushTestPrefix: () => `ptest#`,
  pushHealth: () => `pushhealth`,
  // When each reminder kind's toggle was last switched back on: what fired while it was off stays quiet.
  pushArm: () => `pusharm`,

  // Calendar two-way sync cursor, one per connected Google account (by `sub`).
  gcalSync: (sub: string) => `gcal#sync#${sub}`,
  gcalSyncPrefix: () => `gcal#sync#`,

  // Finances. Plaid owns the ids of items/accounts/transactions (not ULIDs); rules are ours. Each kind
  // is its own prefix so a begins_with pulls exactly one. Transactions are also on GSI1 by date.
  finItem: (itemId: string) => `fin#item#${itemId}`,
  finItemPrefix: () => `fin#item#`,
  finSync: (itemId: string) => `fin#sync#${itemId}`,
  finSyncPrefix: () => `fin#sync#`,
  finAcct: (accountId: string) => `fin#acct#${accountId}`,
  finAcctPrefix: () => `fin#acct#`,
  finTxn: (txnId: string) => `fin#txn#${txnId}`,
  finTxnPrefix: () => `fin#txn#`,
  finRule: (id: string) => `fin#rule#${id}`,
  finRulePrefix: () => `fin#rule#`,
} as const;

// GSI1 — the one index, three key spaces. Done tasks by completion time (calibration reads by range
// instead of scanning every task). GSI1SK is the raw epoch-ms number in every space; DynamoDB sorts Number
// attributes numerically.
export const gsi1 = {
  donePk: (userId: string) => `u#${userId}#done`,
  doneSk: (completedAt: number) => completedAt,
  // What may ping, by when (reminders.md): an open task with a deadline, a plan, a Send-test row. The
  // poller reads the last REMINDER_WINDOW_MS of it each minute; the SK prefix tells the rows apart.
  remindPk: (userId: string) => `u#${userId}#remind`,
  remindSk: (fireAtMs: number) => fireAtMs,
  // Finance transactions by date (the overview's window read). The sort key is the date's UTC-midnight
  // epoch ms — parsed from the YYYY-MM-DD string, never `new Date(str)` (local-time parsing).
  finTxnPk: (userId: string) => `u#${userId}#fintxn`,
  finTxnSk: (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  },
} as const;
