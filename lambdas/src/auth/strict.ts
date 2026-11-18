// Strict auth: on a deployed stage, an unset token or secret REFUSES — never the 'local' dev user or the
// dev state key. The deploy checks (cdk ciSecrets.ts `stageSecret`, deploy-stage's Validate mode) are the
// first layer; this is the second, in the handler itself (docs/arch/INFRA.md §10 → _Fail closed on a stage_).
// AWS_LAMBDA_FUNCTION_NAME is reserved and set by the Lambda runtime, so the config gap this guards against
// can't remove it; STAGE is OR'd in so a stage-tagged local run (the local devcheck server) is strict too.
// Read per call, never cached, like ORIGIN_SECRET.
export const strictAuth = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.AWS_LAMBDA_FUNCTION_NAME) || Boolean(env.STAGE);

// The auth env names a strict function lacks — for its cold-start log line (names only, never values).
export const missingAuthEnv = (names: string[], env: NodeJS.ProcessEnv = process.env): string[] =>
  strictAuth(env) ? names.filter((n) => !env[n]) : [];

// Logs once at cold start when a strict function lacks any of `required`; requests then refuse per path. An unset
// `optional` one (DEVICE_USER_ID: devb binds none, by design) is a plain info line — its token paths refuse too.
// Names only, never values. The refusals themselves read like any bad credential, so these lines are the diagnosis.
export function logMissingAuthEnv(fn: string, required: string[], optional: string[] = []): void {
  const missing = missingAuthEnv(required);
  if (missing.length) console.error(JSON.stringify({ event: 'auth_misconfigured', fn, missing }));
  const unset = missingAuthEnv(optional);
  if (unset.length) console.log(JSON.stringify({ event: 'auth_unbound', fn, unset }));
}

// The CloudFront origin gate (HTTP calls only — the caller checks): the stamped header must match the secret.
// An unset secret skips the gate off a stage (local dev, tests) and refuses on one, logged once per container so
// public traffic can't drive log volume.
let originUnsetLogged = false;
export function originPasses(
  header: string | undefined,
  secret: string | undefined,
  fn: string,
  strict: boolean = strictAuth(),
): boolean {
  if (secret) return header === secret;
  if (strict && !originUnsetLogged) {
    originUnsetLogged = true;
    console.error(JSON.stringify({ event: 'origin_secret_unset', fn }));
  }
  return !strict;
}
export const resetOriginLogForTest = (): void => {
  originUnsetLogged = false;
};

// The OAuth state HMAC key: ORIGIN_SECRET, or the fixed dev key off a stage only.
export const DEV_STATE_SECRET = 'dev-state-secret';
export function stateKey(secret: string | undefined, strict: boolean = strictAuth()): string {
  if (secret) return secret;
  if (strict) throw new Error('OAuth state key not configured on this stage');
  return DEV_STATE_SECRET;
}
