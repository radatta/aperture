// claude.ai custom-connector OAuth redirect URIs — registered as Cognito callback URLs on the claude
// app client so the connector's authorization-code flow can return. Not account-specific, so committed
// here rather than passed as a secret. Confirmed against Anthropic's connector docs (2026-09):
//   - claude.ai/... is the current, live value for the hosted surfaces (web, Desktop, mobile).
//   - claude.com/... is a documented future fallback Anthropic itself suggests allow-listing; not yet
//     live, included defensively so a switch doesn't require a redeploy.
// A wrong/stale value fails loudly as a Cognito `redirect_mismatch` on the hosted-UI login — the fix is
// a one-constant change + redeploy, never a silent misroute. Re-confirm at build time; they can drift.
export const CLAUDE_CONNECTOR_CALLBACK_URLS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
