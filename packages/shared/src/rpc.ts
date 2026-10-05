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
  'createTasks',
  'setTaskEstimate',
  'setTaskCategory',
  'setTaskDueDay',
  'setTaskDue',
  'setTaskTitle',
  'setTaskNotes',
  'transitionTask',
  'setTaskActual',
  'splitTask',
  'deleteTask',
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
  'listRolls',
  'upsertRoll',
  'pickRollToday',
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
  'recordLeetcodeAttempt',
  'listLeetcodeAttempts',
  'listStories',
  'createStory',
  'updateStory',
  'deleteStory',
  'googleConnectUrl',
  'getGoogleStatus',
  'listGoogleCalendars',
  'getCalendarBusy',
  'insertCalendarEvent',
  'deleteCalendarEvent',
  'syncCalendarEvent',
  'disconnectGoogleAccount',
  'createAttachmentUploadUrl',
  'confirmAttachment',
  'listAttachments',
  'getAttachmentDownloadUrl',
  'deleteAttachment',
  'getFinanceOverview',
  'listFinanceTransactions',
  'setFinanceBucket',
  'setFinancePeriodOverride',
  'setFinanceNote',
  'setFinancePeriodStart',
  'linkFinanceRefund',
  'listFinanceRules',
  'upsertFinanceRule',
  'deleteFinanceRule',
  'updateFinanceAccount',
  'createPlaidLinkToken',
  'exchangePlaidPublicToken',
  'completePlaidUpdate',
  'removePlaidItem',
  'requestFinanceSync',
  'exportData',
] as const;

export type ApiMethod = (typeof API_METHODS)[number];

export const isApiMethod = (m: string): m is ApiMethod =>
  (API_METHODS as readonly string[]).includes(m);

export interface RpcRequest {
  args: unknown[];
  testMode?: boolean; // smoke path: run reads + logic, persist nothing (writes-object no-op)
}

// The JWT rides in a CUSTOM header, not Authorization: kept distinct so nothing downstream mistakes it
// for a SigV4 credential. Client sends this, handler reads it (shared name → the two halves can't drift).
export const AUTH_HEADER = 'x-aperture-authorization';

// The MCP server's static agent-token header. A long-lived personal key (like DEVICE_TOKEN, same class
// and delivery as ORIGIN_SECRET) that authenticates Claude Code → /mcp for ANY method — the agent token
// is a full app session, so the /mcp edge disambiguates by credential (this header present → the agent),
// not by method. Distinct from AUTH_HEADER so the token revokes independently and never collides with a
// browser JWT. Its value is NOT prefixed with "Bearer" — the client sends the raw token as this header.
export const AGENT_TOKEN_HEADER = 'x-aperture-agent-token';

// Origin-lockdown secret. The Lambda Function URL is public (auth NONE — OAC can't SigV4-sign POST
// bodies to a Function URL), so CloudFront stamps this shared secret on every origin request and the
// handler rejects anything without it. Anti-abuse only — the Cognito JWT is the real auth gate. The
// value is generated per-env into a gitignored file at synth; both CloudFront + the Lambda read it from
// that one source (shared header name → no drift).
export const ORIGIN_SECRET_HEADER = 'x-aperture-origin-secret';
