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
