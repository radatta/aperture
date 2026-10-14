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
  'WRONG_USER', // the signed-in identity isn't the test user — aborts before any write
  'BUILD_MISMATCH_IN_PAGE', // the page kept serving another build after reloads (PWA service worker)
  'STEP_FAILED', // a scenario step threw
  'LEDGER_GUARD', // a delete was attempted on an id the ledger never recorded
  'LEFTOVERS', // a ledger id still exists after cleanup
  'DEV_CHANGED_MID_RUN', // dev's build changed between start and end — main won; rebase and rerun
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export class DevcheckError extends Error {
  readonly code: ReasonCode;
  constructor(code: ReasonCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DevcheckError';
    this.code = code;
  }
}

export const codeOf = (err: unknown): ReasonCode | undefined =>
  err instanceof DevcheckError ? err.code : undefined;
