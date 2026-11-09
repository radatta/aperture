// The dev kill switch (docs/ops/CI-BOT.md → Kill switch). Runs in the management account (ApertureOrg), fired by a
// dev-account alarm (EventBridge) or the dev budget (SNS). Every move is idempotent, so a retry or a second trigger
// is harmless, and each runs even if another fails:
//   1. attach the deny-all SCP to the dev account — every API call by a dev principal stops (the break-glass role
//      is exempt, so the moves below and the unkill still work);
//   2. throttle every dev function to reserved concurrency 0 — an SCP never sees Lambda's own async queue (events
//      queued before the kill retry for hours) or a public URL's invokes; a function at 0 runs nothing, whoever calls;
//   3. switch the public Function URLs to AWS_IAM — the URL path is resource-based, so this closes it even if 2
//      fails, and CloudFront's origin requests carry no SigV4, so the app goes dark too;
//   4. disable dev's CloudFront distributions — CloudFront serves its cache and reads S3 as a service principal,
//      out of an SCP's reach, so egress would otherwise keep billing after the kill.
// Any failure throws, so Lambda's async retries and the failure destination (an email) take over.
// `restore` reverses 2–4 for the unkill, putting each function's own reservation back (dev's compute cap, which a
// later deploy wouldn't repair: the template still says N); detaching the SCP stays a human step.

export interface KillConfig {
  policyId: string; // the aperture-dev-kill SCP
  devAccountId: string;
  devRegion: string;
  breakGlassRoleArn: string; // the dev account's OrganizationAccountAccessRole
  urlFunctions: string[]; // dev functions with a public Function URL
}

// Each dev function's reserved concurrency, which restore puts back. Read only on a restore (reservationsFrom), so a
// bad value can never stop a kill.
export type Reservations = Record<string, number>;

export interface KillGateways {
  attachPolicy(policyId: string, targetId: string): Promise<'attached' | 'already'>;
  listFunctions(): Promise<string[]>;
  setConcurrency(functionName: string, value: number | null): Promise<void>; // null → remove the reservation
  setUrlAuth(functionName: string, auth: 'AWS_IAM' | 'NONE'): Promise<void>;
  setDistributionsEnabled(enabled: boolean): Promise<string[]>; // ids changed
}

type Log = (line: string) => void;

// A function that doesn't exist (gone since the listing, or a URL function a slot hasn't deployed yet) can't run or be
// reached, so its move is done: logged, not failed.
async function each(failures: string[], log: Log, label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException')
      log(`${label}: no such function, skipped`);
    else failures.push(`${label}: ${message(err)}`);
  }
}

// App functions are `aperture-…`; CDK's provider functions are `Aperture…` (FrozenProviderCode, org-stack.ts).
const isAppFunction = (fn: string) => fn.startsWith('aperture-');

export async function kill(cfg: KillConfig, gw: KillGateways, log: Log): Promise<void> {
  const failures: string[] = [];
  await each(failures, log, `attach ${cfg.policyId}`, async () => {
    const r = await gw.attachPolicy(cfg.policyId, cfg.devAccountId);
    log(
      r === 'already'
        ? `kill SCP already on ${cfg.devAccountId}`
        : `kill SCP attached to ${cfg.devAccountId}`,
    );
  });
  for (const fn of await functionsToCover(cfg, gw, failures, log))
    await each(failures, log, `throttle ${fn}`, async () => {
      await gw.setConcurrency(fn, 0);
      log(`${fn} → concurrency 0`);
    });
  for (const fn of cfg.urlFunctions)
    await each(failures, log, `lock ${fn}`, async () => {
      await gw.setUrlAuth(fn, 'AWS_IAM');
      log(`${fn} URL → AWS_IAM`);
    });
  await each(failures, log, 'disable distributions', async () => {
    log(
      `distributions disabled: ${(await gw.setDistributionsEnabled(false)).join(', ') || 'none were enabled'}`,
    );
  });
  if (failures.length) throw new Error(`kill incomplete — ${failures.join('; ')}`);
}

export async function restore(
  cfg: KillConfig,
  reservations: Reservations,
  gw: KillGateways,
  log: Log,
): Promise<void> {
  const failures: string[] = [];
  for (const fn of await functionsToCover(cfg, gw, failures, log))
    await each(failures, log, `unthrottle ${fn}`, async () => {
      const n = reservations[fn];
      if (n !== undefined) {
        await gw.setConcurrency(fn, n);
        log(`${fn} → concurrency ${n}`);
      } else if (isAppFunction(fn)) {
        // An app function with no reservation on record stays at 0: removing it would lift its cap to the account
        // quota. The hand fix is a break-glass put-function-concurrency (CI-BOT.md → Unkill).
        throw new Error('no reservation on record, left at 0');
      } else {
        // A CDK provider function (ApertureCicdDev's OIDC provider, say) was never reserved: this puts it back as it was.
        await gw.setConcurrency(fn, null);
        log(`${fn} → reservation removed (not an app function)`);
      }
    });
  for (const fn of cfg.urlFunctions)
    await each(failures, log, `unlock ${fn}`, async () => {
      await gw.setUrlAuth(fn, 'NONE');
      log(`${fn} URL → NONE`);
    });
  await each(failures, log, 'enable distributions', async () => {
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
  log: Log,
): Promise<string[]> {
  let listed: string[] = [];
  await each(failures, log, 'list functions', async () => {
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

// The restore's table, `<function>=<n>,…`. Fails closed: a restore that guessed a value would lift or strand a cap.
export function reservationsFrom(
  env: Record<string, string | undefined>,
  urlFunctions: string[],
): Reservations {
  const raw = env.RESERVED_CONCURRENCY?.trim();
  if (!raw) throw new Error('restore: RESERVED_CONCURRENCY is not set');
  const out: Reservations = {};
  for (const pair of raw.split(',').filter((p) => p.trim())) {
    const parts = pair.split('=').map((x) => x.trim());
    const [fn, value] = parts;
    const n = Number(value);
    if (parts.length !== 2 || !fn || !value || !Number.isInteger(n) || n < 1)
      throw new Error(
        `restore: RESERVED_CONCURRENCY entry "${pair}" is not <function>=<positive integer>`,
      );
    if (fn in out) throw new Error(`restore: RESERVED_CONCURRENCY names ${fn} twice`);
    out[fn] = n;
  }
  const missing = urlFunctions.filter((fn) => out[fn] === undefined);
  if (missing.length)
    throw new Error(`restore: RESERVED_CONCURRENCY has no entry for ${missing.join(', ')}`);
  return out;
}

const message = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

// Every dev distribution to `enabled`, as the kill's move 4 and its restore. Each one is tried even if another fails;
// a distribution whose config can't be read is a failure, never a silent skip.
export interface CloudFrontLike {
  list(marker?: string): Promise<{ items: { id: string; enabled: boolean }[]; next?: string }>;
  getConfig(
    id: string,
  ): Promise<{ config?: { Enabled?: boolean } & Record<string, unknown>; etag?: string }>;
  update(id: string, etag: string | undefined, config: Record<string, unknown>): Promise<void>;
}

export async function setDistributionsEnabled(
  cf: CloudFrontLike,
  enabled: boolean,
): Promise<string[]> {
  const changed: string[] = [];
  const failures: string[] = [];
  let marker: string | undefined;
  do {
    const page = await cf.list(marker);
    for (const d of page.items) {
      if (d.enabled === enabled) continue;
      // A distribution's not-found stays a failure: only a function's absence means its move is done.
      await each(
        failures,
        (l) => failures.push(l),
        d.id,
        async () => {
          const { config, etag } = await cf.getConfig(d.id);
          if (!config) throw new Error('no distribution config returned');
          await cf.update(d.id, etag, { ...config, Enabled: enabled });
          changed.push(d.id);
        },
      );
    }
    marker = page.next;
  } while (marker);
  if (failures.length)
    throw new Error(
      `distributions not ${enabled ? 'enabled' : 'disabled'} — ${failures.join('; ')}`,
    );
  return changed;
}
