// The dev account's fixed names (INFRA §2): shared by the management-account kill path (org-stack.ts), the dev
// account's alarms (dev-guard-stack.ts) and their tests, so a rename can't split them.
import { DEV_SLOTS } from '@aperture/shared';

export const DEV_REGION = 'us-west-1';
// The dev functions with a public Function URL, on every dev slot — the kill switch locks these to AWS_IAM. Named,
// not discovered: the freeze denies the bot lane a new URL, so the list is complete by construction (a test pins it).
export const DEV_URL_FUNCTIONS = DEV_SLOTS.flatMap((slot) =>
  ['bff', 'mcp'].map((fn) => `aperture-${fn}-${slot}`),
);
// Alarms named with this prefix trip the kill; the SCP keeps everything but the break-glass role away from them.
export const KILL_ALARM_PREFIX = 'aperture-kill-';
// The dev-account role EventBridge assumes to carry a kill alarm to the management account's bus.
export const KILL_FORWARDER_ROLE = `${KILL_ALARM_PREFIX}forwarder`;
// Main's own dev deploy (docs/ops/CI-BOT.md → Two lanes): the second CDK bootstrap's qualifier, whose execution role
// the freeze exempts, and the GitHub role — trusted only from the main-only `dev-main` environment — that alone may
// assume its roles. Every dev-account GitHub role shares the prefix the guardrails protect.
export const STOCK_QUALIFIER = 'hnb659fds';
export const DEVMAIN_QUALIFIER = 'devmain';
export const GITHUB_ROLE_PREFIX = 'aperture-github-';
export const DEV_MAIN_GITHUB_ROLE = `${GITHUB_ROLE_PREFIX}dev-main`;
// Each dev function's reserved concurrency (CI-BOT.md → What's capped → Compute). Their sum, not the account quota,
// is dev's real ceiling, so the worst case holds whatever the quota. A slot is one dev stack's functions; Rahul's
// call (2026-11-08) is this ceiling per slot. Keyed by full name like DEV_URL_FUNCTIONS: the kill's restore puts
// these back (org-stack.ts → RESERVED_CONCURRENCY), so a change here needs an ApertureOrg redeploy too.
export const DEV_CONCURRENCY_CEILING = 30;
// One dev stack's shares, by function; every slot gets the same.
const SLOT_RESERVED_CONCURRENCY: Readonly<Record<string, number>> = {
  bff: 18, // a page keeps ≤ 8 /api in flight, the harness ~2: room for a phone beside a devcheck
  mcp: 10, // a devcheck's /mcp steps beside a live connector session
  'finance-sync': 1, // the per-item lock serialises anyway; a throttled async event is retried
  'push-dispatch': 1, // one tick at a time, as on prod
};
export const DEV_RESERVED_CONCURRENCY: Readonly<Record<string, number>> = Object.fromEntries(
  DEV_SLOTS.flatMap((slot) =>
    Object.entries(SLOT_RESERVED_CONCURRENCY).map(([fn, n]) => [`aperture-${fn}-${slot}`, n]),
  ),
);
// Prod's only reservation: push-dispatch's one-tick-at-a-time rule (D3). Prod's other functions stay unreserved.
const PROD_RESERVED_CONCURRENCY: Readonly<Record<string, number>> = {
  'aperture-push-dispatch-prod': 1,
};

// The function's reservedConcurrentExecutions prop. Prod reserves only what its table names; every other stage is a
// dev slot (dev, and slot B's), where a name with no entry fails synth. A construct that never calls this is caught by
// stacks.test.ts, which fails for any dev function deployed without its table value.
export function reservedConcurrency(
  stage: string,
  functionName: string,
): { reservedConcurrentExecutions?: number } {
  if (stage === 'prod') {
    const n = PROD_RESERVED_CONCURRENCY[functionName];
    return n === undefined ? {} : { reservedConcurrentExecutions: n };
  }
  const n = DEV_RESERVED_CONCURRENCY[functionName];
  if (n === undefined)
    throw new Error(
      `${functionName} has no reserved concurrency (DEV_RESERVED_CONCURRENCY in config/devAccount.ts)`,
    );
  return { reservedConcurrentExecutions: n };
}

// A dev function's slot: its name's last segment, the stage (`aperture-bff-dev` → `dev`). So a slot's stage name
// can't contain a hyphen (`devb`, not `dev-b`).
export const slotOf = (functionName: string) =>
  functionName.slice(functionName.lastIndexOf('-') + 1);
