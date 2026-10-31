// The dev kill switch (docs/ops/CI-BOT.md → Kill switch). Runs in the management account (ApertureOrg), fired by a
// dev-account alarm (EventBridge) or the dev budget (SNS). Two moves, both idempotent, so a retry or a second
// trigger is harmless:
//   1. attach the deny-all SCP to the dev account — every API call by a dev principal stops (the break-glass role
//      is exempt, so the unkill still works);
//   2. switch dev's public Function URLs to AWS_IAM — compute driven through a URL is resource-based, the one path
//      an SCP can't reach, and CloudFront's origin requests carry no SigV4, so the app goes dark too.
// Both run even if the other fails; any failure throws, so Lambda's async retries and the failure destination
// (an email) take over.

export interface KillConfig {
  policyId: string; // the aperture-dev-kill SCP
  devAccountId: string;
  urlFunctions: string[]; // dev functions with a public Function URL
}

export interface KillGateways {
  attachPolicy(policyId: string, targetId: string): Promise<'attached' | 'already'>;
  lockFunctionUrl(functionName: string): Promise<void>;
}

export async function kill(
  cfg: KillConfig,
  gw: KillGateways,
  log: (line: string) => void,
): Promise<void> {
  const failures: string[] = [];
  try {
    const r = await gw.attachPolicy(cfg.policyId, cfg.devAccountId);
    log(
      r === 'already'
        ? `kill SCP already on ${cfg.devAccountId}`
        : `kill SCP attached to ${cfg.devAccountId}`,
    );
  } catch (err) {
    failures.push(`attach ${cfg.policyId}: ${message(err)}`);
  }
  for (const fn of cfg.urlFunctions) {
    try {
      await gw.lockFunctionUrl(fn);
      log(`${fn} URL → AWS_IAM`);
    } catch (err) {
      failures.push(`lock ${fn}: ${message(err)}`);
    }
  }
  if (failures.length) throw new Error(`kill incomplete — ${failures.join('; ')}`);
}

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
  return { policyId: need('KILL_POLICY_ID'), devAccountId: need('DEV_ACCOUNT_ID'), urlFunctions };
}

const message = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
