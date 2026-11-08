// The app client's refresh token goes 7 → 30 days, revocation pinned on (TECH §3). A refresh token is
// opaque, so dev can't read its expiry: what dev proves is that a refresh-token grant against the updated
// client works. The value itself is the template's (stacks.test.ts) and the live client's (a one-line read).
import type { Scenario } from '../scenario';

const STACKS = 'cdk/src/stacks.test.ts';
const OPAQUE = 'a refresh token is opaque: nothing in the app or the harness can read its expiry';

export const cognitoRefresh: Scenario = {
  id: 'cognito-refresh',
  title: 'The app’s refresh token lasts 30 days, and still renews',
  tiers: ['full'],
  rows: [
    {
      id: 'renews-after-update',
      entry: 'ui',
      kind: 'nominal',
      what: 'After the client update, a refresh-token grant against it succeeds and the app stays signed in',
    },
    {
      id: 'template-30d',
      entry: 'ui',
      kind: 'nominal',
      what: 'The app client issues refresh tokens valid 30 days, revocable',
      offDev: {
        file: STACKS,
        test: 'caps the SPA refresh token at 30 days, revocable',
        why: `the template is the artefact; ${OPAQUE}, and the live client's value is a needs-you read`,
      },
    },
    {
      id: 'claude-client-unchanged',
      entry: 'ui',
      kind: 'edge',
      what: 'The claude.ai connector’s client is unchanged: 30 days, code flow, its callbacks',
      offDev: {
        file: STACKS,
        test: 'provisions the claude.ai MCP OAuth client (30-day refresh, code flow, connector callbacks)',
        why: 'a template neighbour: its resource is untouched, and the test pins it by name',
      },
    },
    {
      id: 'live-30d',
      entry: 'ui',
      kind: 'nominal',
      what: 'Dev’s deployed app client reports 43200 minutes and token revocation on',
      needsYou:
        'the container has no AWS credentials: the describe-user-pool-client one-liner in the PR body',
    },
    {
      id: 'next-signin-30d',
      entry: 'ui',
      kind: 'nominal',
      what: 'After your next sign-in, the phone and the Simulator don’t ask again for 30 days',
      needsYou: `calendar time; ${OPAQUE}. Day 8 (the old ceiling) is the first tell`,
    },
    {
      id: 'old-session-keeps-7d',
      entry: 'ui',
      kind: 'edge',
      what: 'A session signed in before the deploy still runs out on its original 7-day clock',
      needsYou: `${OPAQUE}; inferred, not proven: a token keeps the validity it was issued with`,
    },
    {
      id: 'stolen-token-recovery',
      entry: 'ui',
      kind: 'edge',
      what: 'admin-user-global-sign-out stops a stolen refresh token at once; its last access token still works at the API for up to an hour',
      needsYou:
        'only an AWS admin call can run it; on the test user it would also cost the next dev check a fresh sign-in',
    },
  ],
  steps: [
    {
      id: 'renews',
      entry: 'ui',
      proves: ['renews-after-update'],
      title: 'A refresh-token grant against the updated client succeeds; the app stays signed in',
      async run(ctx) {
        // A page load alone renews nothing while the access token is fresh. Marking it expired makes the
        // next load renew it from the stored refresh token, at the token endpoint (OidcBridge, on load).
        await ctx.ui.goto('/tasks');
        const marked = await ctx.page.evaluate<number>(`(() => {
          let n = 0;
          for (const k of Object.keys(localStorage)) {
            if (!k.startsWith('oidc.user:')) continue;
            const u = JSON.parse(localStorage.getItem(k));
            if (!u || !u.refresh_token) continue;
            u.expires_at = Math.floor(Date.now() / 1000) - 60;
            localStorage.setItem(k, JSON.stringify(u));
            n++;
          }
          return n;
        })()`);
        if (marked !== 1)
          throw new Error(`expected one stored session with a refresh token, found ${marked}`);
        const grant = ctx.page.waitForResponse(
          (r) => r.url().includes('.amazoncognito.com/oauth2/token'),
          { timeout: 20_000 },
        );
        await ctx.ui.goto('/tasks');
        const res = await grant;
        if (!res.request().postData?.()?.includes('grant_type=refresh_token'))
          throw new Error('the token request was not a refresh-token grant');
        if (res.status() !== 200)
          throw new Error(`the refresh-token grant answered ${res.status()}`);
        await ctx.ui.expectText('Backlog');
        await ctx.shot('signed-in');
      },
    },
  ],
};
