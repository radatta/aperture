// The dev check's reason codes — one home. A FAIL report lists the codes it hit; docs/ops/DEV-CHECK.md says
// what each means and what to do about it.
export const REASON_CODES = [
  'ENV_MISSING', // .secrets/devcheck.dev.env absent or missing a key
  'PW_MISSING', // Playwright not installed at ~/pw (or DEVCHECK_PW_ROOT)
  'DEPLOY_NOT_FOUND', // no dev deploy run for the expected SHA
  'DEPLOY_FAILED', // the run for that SHA did not succeed
  'DEPLOY_TIMEOUT', // the run succeeded but the edge never served the SHA's marker
  'AUTH_REDIRECT_UNEXPECTED', // Sign in went somewhere other than the dev Hosted UI
  'AUTH_PAGE_CHANGED', // the Hosted UI form isn't the classic one the harness knows
  'AUTH_REJECTED', // Cognito refused the test user's credentials
  'MCP_AUTH_FAILED', // the claude-client PKCE sign-in failed before any step: a Cognito error, state mismatch, the token endpoint refused, the callback never came, came twice or wasn't blocked (a token expiring mid-run fails its step instead)
  'WRONG_USER', // the signed-in identity isn't the test user — aborts before any write
  'BUILD_MISMATCH_IN_PAGE', // the page kept serving another build after reloads (PWA service worker)
  'MATRIX_GAP', // a coverage row no step proves through its own entry point, or an off-dev test that doesn't exist — found at load
  'STEP_FAILED', // a scenario step threw
  'LEDGER_GUARD', // a delete was attempted on an id the ledger never recorded
  'LEFTOVERS', // something may be left on dev: a surviving or undeletable ledger id, an unanswered create, an unrecorded new task
  'DEV_CHANGED_MID_RUN', // dev's build changed between start and end — main won; rebase and rerun
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export class DevcheckError extends Error {
  readonly code: ReasonCode;
  readonly detail: string; // the text alone — `message` carries the `CODE: ` prefix for steps and stderr
  constructor(code: ReasonCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DevcheckError';
    this.code = code;
    this.detail = message;
  }
}

export const codeOf = (err: unknown): ReasonCode | undefined =>
  err instanceof DevcheckError ? err.code : undefined;
export const detailOf = (err: unknown): string | undefined =>
  err instanceof DevcheckError ? err.detail : undefined;
