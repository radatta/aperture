// The dev kill switch (docs/ops/CI-BOT.md → Kill switch). Runs in the management account (ApertureOrg), fired by a
// dev-account alarm (EventBridge) or the dev budget (SNS). Every move is idempotent, so a retry or a second trigger
// is harmless, and each runs even if another fails:
//   1. attach the deny-all SCP to the dev account — every API call by a dev principal stops (the break-glass role
//      is exempt, so the moves below and the unkill still work);
//   2. throttle every dev function to reserved concurrency 0 — an SCP never sees Lambda's own async queue, a
//      schedule's or a URL's invokes; a function at 0 runs nothing, whoever calls it;
//   3. switch the public Function URLs to AWS_IAM — the URL path is resource-based, so this closes it even if 2
//      fails, and CloudFront's origin requests carry no SigV4, so the app goes dark too;
//   4. disable dev's CloudFront distributions — CloudFront serves its cache and reads S3 as a service principal,
//      out of an SCP's reach, so egress would otherwise keep billing after the kill.
// Any failure throws, so Lambda's async retries and the failure destination (an email) take over.
// `restore` reverses 2–4 for the unkill; detaching the SCP stays a human step.

export interface KillConfig {
  policyId: string; // the aperture-dev-kill SCP
  devAccountId: string;
  devRegion: string;
  breakGlassRoleArn: string; // the dev account's OrganizationAccountAccessRole
  urlFunctions: string[]; // dev functions with a public Function URL
}

export interface KillGateways {
  attachPolicy(policyId: string, targetId: string): Promise<'attached' | 'already'>;
  listFunctions(): Promise<string[]>;
  setConcurrency(functionName: string, value: 0 | null): Promise<void>; // null → remove the reservation
  setUrlAuth(functionName: string, auth: 'AWS_IAM' | 'NONE'): Promise<void>;
  setDistributionsEnabled(enabled: boolean): Promise<string[]>; // ids changed
}

type Log = (line: string) => void;

async function each(failures: string[], label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${label}: ${message(err)}`);
  }
}

export async function kill(cfg: KillConfig, gw: KillGateways, log: Log): Promise<void> {
  const failures: string[] = [];
  await each(failures, `attach ${cfg.policyId}`, async () => {
    const r = await gw.attachPolicy(cfg.policyId, cfg.devAccountId);
    log(
      r === 'already'
        ? `kill SCP already on ${cfg.devAccountId}`
        : `kill SCP attached to ${cfg.devAccountId}`,
    );
  });
  for (const fn of await functionsToCover(cfg, gw, failures))
    await each(failures, `throttle ${fn}`, async () => {
      await gw.setConcurrency(fn, 0);
      log(`${fn} → concurrency 0`);
    });
  for (const fn of cfg.urlFunctions)
    await each(failures, `lock ${fn}`, async () => {
      await gw.setUrlAuth(fn, 'AWS_IAM');
      log(`${fn} URL → AWS_IAM`);
    });
  await each(failures, 'disable distributions', async () => {
    log(
      `distributions disabled: ${(await gw.setDistributionsEnabled(false)).join(', ') || 'none were enabled'}`,
    );
  });
  if (failures.length) throw new Error(`kill incomplete — ${failures.join('; ')}`);
}

export async function restore(cfg: KillConfig, gw: KillGateways, log: Log): Promise<void> {
  const failures: string[] = [];
  for (const fn of await functionsToCover(cfg, gw, failures))
    await each(failures, `unthrottle ${fn}`, async () => {
      await gw.setConcurrency(fn, null);
      log(`${fn} → reservation removed`);
    });
  for (const fn of cfg.urlFunctions)
    await each(failures, `unlock ${fn}`, async () => {
      await gw.setUrlAuth(fn, 'NONE');
      log(`${fn} URL → NONE`);
    });
  await each(failures, 'enable distributions', async () => {
    log(
      `distributions enabled: ${(await gw.setDistributionsEnabled(true)).join(', ') || 'none were disabled'}`,
    );
  });
  if (failures.length) throw new Error(`restore incomplete — ${failures.join('; ')}`);
}

// Every function in the dev region, plus the URL functions even when the listing fails — those are the ones a
// stranger can reach.
async function functionsToCover(
  cfg: KillConfig,
  gw: KillGateways,
  failures: string[],
): Promise<string[]> {
  let listed: string[] = [];
  await each(failures, 'list functions', async () => {
    listed = await gw.listFunctions();
  });
  return [...new Set([...cfg.urlFunctions, ...listed])];
}

// Only a direct invoke (`aws lambda invoke --payload '{"action":"restore"}'`, a management-account credential) can
// restore. An EventBridge event or an SNS record never carries a top-level `action`, so a trigger can only kill.
export const isRestore = (event: unknown): boolean =>
  typeof event === 'object' &&
  event !== null &&
  (event as { action?: unknown }).action === 'restore' &&
  !('source' in event) &&
  !('Records' in event);

// Organizations answers a second attach of the same policy with this error; the kill treats it as done.
export const isAlreadyAttached = (err: unknown): boolean =>
  err instanceof Error && err.name === 'DuplicatePolicyAttachmentException';

// Fails closed on a missing variable: a kill that silently does nothing is the one outcome that must not happen.
export function killConfigFrom(env: Record<string, string | undefined>): KillConfig {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`kill: ${k} is not set`);
    return v;
  };
  const urlFunctions = need('URL_FUNCTIONS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urlFunctions.length) throw new Error('kill: URL_FUNCTIONS names no function');
  return {
    policyId: need('KILL_POLICY_ID'),
    devAccountId: need('DEV_ACCOUNT_ID'),
    devRegion: need('DEV_REGION'),
    breakGlassRoleArn: need('BREAK_GLASS_ROLE_ARN'),
    urlFunctions,
  };
}

const message = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
