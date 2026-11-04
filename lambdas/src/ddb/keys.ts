// Single-table key layout (TECH §2.4). One partition per user; type-prefixed range keys so a
// begins_with Query pulls exactly one entity kind. Nothing here talks to DynamoDB — pure string math,
// so it's trivially testable and shared by the in-memory and the real DocClient alike.
//
// The one partition that is NOT a user's: `placetoken#<sha256hex> / placetoken`, the Shortcut token's
// lookup row (places.md). The Shortcut route holds only the token, so the row has to be findable by its
// hash before any userId is known — it carries the userId instead. Never read by a user's queries
// (they all start `u#`), never exported.

export const pk = (userId: string) => `u#${userId}`;
export const placeTokenPk = (hash: string) => `placetoken#${hash}`;
export const PLACE_TOKEN_SK = 'placetoken';

// Plan order and GSI completion time are numbers we sort lexically inside the SK — pad to fixed width.
const padOrder = (order: number) => String(Math.max(0, Math.trunc(order))).padStart(6, '0');

export const sk = {
  log: (day: string, id: string) => `log#${day}#${id}`,
  logPrefix: (day: string) => `log#${day}#`,
  logAllPrefix: () => `log#`,

  // LeetCode attempts, day-bucketed like log. Derived reads scan the `lc#` prefix (single-user volume,
  // same posture as calibration scanning tasks). Dedup-by-submission-id is a prefix scan for now.
  lc: (day: string, id: string) => `lc#${day}#${id}`,
  lcPrefix: (day: string) => `lc#${day}#`,
  lcAllPrefix: () => `lc#`,

  // Flux sets (D47), day-bucketed like lc. A few rows a day: reads and the by-id lookup scan `flux#`.
  flux: (day: string, id: string) => `flux#${day}#${id}`,
  fluxAllPrefix: () => `flux#`,

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
  // token pointer is a singleton: which lookup row is this user's live token (rotate/revoke find the old
  // one through it). A credential's pointer — never exported.
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

// GSI1 — done tasks by completion time, the one index (calibration reads by range instead of scanning
// every task). GSI1SK is the raw epoch-ms number; DynamoDB sorts Number attributes numerically.
export const gsi1 = {
  donePk: (userId: string) => `u#${userId}#done`,
  doneSk: (completedAt: number) => completedAt,
  // Finance transactions by date (the overview's window read). The sort key is the date's UTC-midnight
  // epoch ms — parsed from the YYYY-MM-DD string, never `new Date(str)` (local-time parsing).
  finTxnPk: (userId: string) => `u#${userId}#fintxn`,
  finTxnSk: (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  },
} as const;
