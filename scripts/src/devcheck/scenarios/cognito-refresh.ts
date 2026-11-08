// The app client's refresh token goes 7 → 30 days, revocation pinned on (TECH §3). A refresh token is
// opaque, so dev can't read its expiry: what dev proves is that a session renews against the updated
// client. The value itself is the template's (stacks.test.ts) and the live client's (a one-line read).
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
      what: 'After the client update the app opens signed in: the launch renews with the refresh token the harness cached before it',
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
      id: 'expired-token-signin',
      entry: 'ui',
      kind: 'edge',
      what: 'A lapsed refresh token lands on the sign-in card with no red error',
      offDev: {
        file: 'app/src/auth/renewal.test.tsx',
        test: 'does not surface an error when the session expires normally',
        why: 'dev can’t age a token on demand; the invalid_grant path is the same whatever the window',
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
      what: 'admin-user-global-sign-out ends every session of the user, its live access tokens included',
      needsYou:
        'only an AWS admin call can run it, and running it on the test user would sign out every dev check',
    },
  ],
  steps: [
    {
      id: 'renews',
      entry: 'ui',
      proves: ['renews-after-update'],
      title: 'The app opens signed in after the client update',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.expectText('Backlog');
        await ctx.shot('signed-in');
      },
    },
  ],
};
