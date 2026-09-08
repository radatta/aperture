// Single-table key layout (TECH §2.4). One partition per user; type-prefixed range keys so a
// begins_with Query pulls exactly one entity kind. Nothing here talks to DynamoDB — pure string math,
// so it's trivially testable and shared by the in-memory and the real DocClient alike.

export const pk = (userId: string) => `u#${userId}`;

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

  cat: (id: string) => `cat#${id}`,
  catPrefix: () => `cat#`,

  idea: (id: string) => `idea#${id}`,
  ideaPrefix: () => `idea#`,

  series: (id: string) => `series#${id}`,
  seriesPrefix: () => `series#`,

  settings: () => `settings`,
} as const;

// GSI1 — done tasks by completion time, the one index (calibration reads by range instead of scanning
// every task). GSI1SK is the raw epoch-ms number; DynamoDB sorts Number attributes numerically.
export const gsi1 = {
  donePk: (userId: string) => `u#${userId}#done`,
  doneSk: (completedAt: number) => completedAt,
} as const;
