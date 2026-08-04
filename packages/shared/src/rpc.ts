// The wire contract between the app's httpClient and the Lambda handler. One RPC per ApiClient method:
// POST /api/<method> with a JSON body of the positional args; the JSON result is the return value.
// This list is the single source of truth for BOTH halves — the client builds its proxy from it and
// the handler validates against it, so they can never drift.

export const API_METHODS = [
  'listLogEntries',
  'createLogEntry',
  'updateLogEntry',
  'listBacklog',
  'listTasks',
  'getTask',
  'createTask',
  'setTaskEstimate',
  'setTaskCategory',
  'transitionTask',
  'setTaskActual',
  'splitTask',
  'listPlansForDay',
  'upsertPlan',
  'removePlan',
  'listSeries',
  'upsertSeries',
  'deactivateSeries',
  'startSession',
  'heartbeatSession',
  'resumeSession',
  'stopSession',
  'listSessionsForDay',
  'findRunningSession',
  'listRunningSessions',
  'resolveStaleSession',
  'listHabits',
  'upsertHabit',
  'checkHabit',
  'uncheckHabit',
  'listHabitChecks',
  'listIdeas',
  'createIdea',
  'triageIdea',
  'getDay',
  'setDayCapacity',
  'setDayIntent',
  'setDayReflection',
  'listCategories',
  'upsertCategory',
  'setCategoryWork',
  'deleteCategory',
  'getSettings',
  'updateSettings',
  'getCalibration',
  'exportData',
] as const;

export type ApiMethod = (typeof API_METHODS)[number];

export const isApiMethod = (m: string): m is ApiMethod => (API_METHODS as readonly string[]).includes(m);

export interface RpcRequest {
  args: unknown[];
  testMode?: boolean; // smoke path: run reads + logic, persist nothing (writes-object no-op)
}
