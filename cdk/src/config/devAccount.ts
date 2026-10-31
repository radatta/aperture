// The dev account's fixed names (INFRA §2): shared by the management-account kill path (org-stack.ts), the dev
// account's alarms (dev-guard-stack.ts) and their tests, so a rename can't split them.
export const DEV_REGION = 'us-west-1';
// The dev functions with a public Function URL — the kill switch locks these to AWS_IAM.
export const DEV_URL_FUNCTIONS = ['aperture-bff-dev', 'aperture-mcp-dev'];
// Alarms named with this prefix trip the kill; the SCP keeps everything but the break-glass role away from them.
export const KILL_ALARM_PREFIX = 'aperture-kill-';
