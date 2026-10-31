// The dev account's fixed names (INFRA §2): shared by the management-account kill path (org-stack.ts), the dev
// account's alarms (dev-guard-stack.ts) and their tests, so a rename can't split them.
export const DEV_REGION = 'us-west-1';
// The dev functions with a public Function URL — the kill switch locks these to AWS_IAM.
export const DEV_URL_FUNCTIONS = ['aperture-bff-dev', 'aperture-mcp-dev'];
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
