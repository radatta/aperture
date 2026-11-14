// Personal identifiers out of the public repo (docs/ops/IDENTIFIERS.md). What dev can show: the run signs in as the
// test user on its new address (the dev subdomain, read from identifiers.json — not a personal mailbox), through the
// app and through /mcp, and the about and privacy pages, now built from templates, come out filled. The rules
// themselves — tracked files, commits, PR text — are tests: dev deploys the build, not the repo.
import { IDS } from '../../identifiers.ts';
import { TEST_USER_EMAIL, assertDevOrigin, targetOrigin } from '../config';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const GUARD = 'scripts/src/tracked-identifiers.test.ts';
const SCAN = 'scripts/src/identifiers-scan.test.ts';
const PAGES = 'app/pwa/identityPages.test.ts';
const OPEN_PR = 'scripts/src/mailroom/open-pr.test.ts';
const MAC_ROOT = 'scripts/src/mac-root.test.ts';
const NOT_DEPLOYED = 'a repo-side rule: dev runs the build, never the checkout or a commit';

// The app's oidc session in localStorage: its profile's email.
async function sessionEmail(page: Ctx['page']): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('oidc.user:')) { try { return JSON.parse(localStorage[k]).profile.email ?? null } catch { return null } }
    return null })()`);
}

async function page(ctx: Ctx, path: string, title: RegExp) {
  const url = `${targetOrigin()}${path}`;
  assertDevOrigin(url);
  await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
  // The page itself, not the SPA's index.html fallback: its own title, the filled text, the mailto.
  const [html, docTitle] = await ctx.page.evaluate<[string, string]>(
    '[document.documentElement.outerHTML, document.title]',
  );
  if (/\{\{|\}\}/.test(html)) throw new Error(`${path} still carries a {{token}}`);
  if (!title.test(docTitle)) throw new Error(`${path}'s title is ${docTitle}`);
  if (!html.includes(IDS.maintainer.name))
    throw new Error(`${path} doesn't name the maintainer from identifiers.json`);
  const mail = await ctx.page.locator(`a[href="mailto:${IDS.email.contact}"]`).count();
  if (mail < 1) throw new Error(`${path} has no mailto link to identifiers.json's contact email`);
  await ctx.shot(path.slice(1).replace('.html', ''));
}

export const identifierCleanup: Scenario = {
  id: 'identifier-cleanup',
  title:
    'No personal identifiers: the test user on its new address, the pages filled from identifiers.json',
  tiers: ['full'],
  rows: [
    {
      id: 'login-new-user',
      entry: 'ui',
      kind: 'nominal',
      what: 'The run’s app session is the test user at identifiers.json’s address, on the dev subdomain — no personal mailbox',
    },
    {
      id: 'mcp-new-user',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The /mcp session (claude client) is the same test user, one partition with the app',
    },
    {
      id: 'page-about',
      entry: 'ui',
      kind: 'nominal',
      what: '/about.html is served, names the maintainer and the contact mailto, no {{token}} left',
    },
    {
      id: 'page-privacy',
      entry: 'ui',
      kind: 'nominal',
      what: '/privacy.html likewise (Google’s OAuth consent screen links it)',
    },
    {
      id: 'old-address-refused',
      entry: 'api',
      kind: 'edge',
      what: 'An env file still naming another address is WRONG_USER before any write',
      offDev: {
        file: 'scripts/src/devcheck/config.test.ts',
        test: 'refuses an env file for another user',
        why: 'dev holds one address per user; the guard reads the env file before the browser starts',
      },
    },
    {
      id: 'page-escaped',
      entry: 'ui',
      kind: 'edge',
      what: 'A config value with < or & is HTML-escaped in the pages; an unknown token fails the build',
      offDev: {
        file: PAGES,
        test: 'fills every token, HTML-escaped',
        why: 'dev ships the real values only',
      },
    },
    {
      id: 'tracked-clean',
      entry: 'api',
      kind: 'nominal',
      what: 'No tracked file but identifiers.json (and the sim runner’s one pin) holds a personal identifier',
      offDev: {
        file: GUARD,
        test: 'only identifiers.json and the sim runner pin hold one',
        why: NOT_DEPLOYED,
      },
    },
    {
      id: 'tracked-seeded',
      entry: 'api',
      kind: 'edge',
      what: 'A seeded name or home path in a throwaway tree fails the guard; the config itself is exempt',
      offDev: {
        file: GUARD,
        test: 'a seeded hit in a throwaway tree fails, and the config itself is exempt',
        why: NOT_DEPLOYED,
      },
    },
    {
      id: 'public-values-pass',
      entry: 'api',
      kind: 'edge',
      what: 'The domain, the GitHub login, the bundle prefix and a placeholder mailbox are not hits',
      offDev: {
        file: GUARD,
        test: 'lets the domain, the GitHub login and the bundle prefix through',
        why: NOT_DEPLOYED,
      },
    },
    {
      id: 'pins-equal-config',
      entry: 'api',
      kind: 'nominal',
      what: 'Every Mac-installed literal (labels, repo slug, test address, the sim’s Cognito host) equals identifiers.json',
      offDev: {
        file: GUARD,
        test: 'every Mac-installed literal equals identifiers.json',
        why: 'the installed runner is fetched from GitHub; dev never runs it',
      },
    },
    {
      id: 'commit-blocked',
      entry: 'api',
      kind: 'nominal',
      what: 'A commit adding an identifier — in a line or the message, WIP too — is denied, naming path:line, never the identifier',
      offDev: {
        file: SCAN,
        test: 'checks the command (its message) as well as the diff',
        why: `${NOT_DEPLOYED}; the hook's own wiring is .claude/hooks/testdata/precommit-fixtures.jsonl (run-fixtures.py), which no vitest runs yet`,
      },
    },
    {
      id: 'commit-cleanup-passes',
      entry: 'api',
      kind: 'edge',
      what: 'A commit that only removes an identifier passes',
      offDev: {
        file: SCAN,
        test: 'ignores removed lines and a deleted file, so a cleanup commit passes',
        why: NOT_DEPLOYED,
      },
    },
    {
      id: 'pr-text-refused',
      entry: 'api',
      kind: 'nominal',
      what: 'open-pr refuses a title or body naming an identifier before queueing or printing a hand-off line',
      offDev: {
        file: OPEN_PR,
        test: 'refuses a personal identifier in the title or body before anything is queued or handed over',
        why: 'container-side; the Mac never sees the job',
      },
    },
    {
      id: 'mac-root-missing',
      entry: 'api',
      kind: 'edge',
      what: 'No or a malformed .local/mac-root gives <mac-repo> plus how to write it, never a guessed path',
      offDev: {
        file: MAC_ROOT,
        test: 'macRoot falls back to the placeholder',
        why: 'a container-side file; dev has none',
      },
    },
    {
      id: 'live-hook',
      entry: 'api',
      kind: 'nominal',
      what: 'In a real session on merged main, a commit naming the maintainer is denied',
      needsYou:
        'hooks load from /workspace, which stays on main until the merge; the first session after it shows it',
    },
    {
      id: 'sim-fresh-signin',
      entry: 'ios',
      kind: 'edge',
      what: 'A signed-out Simulator signs in typing the new address',
      needsYou:
        'the installed runner types its pinned address: after the Cleanup reinstall, and only when the sim is signed out (≤ monthly)',
    },
  ],
  steps: [
    {
      id: 'app-session',
      entry: 'ui',
      proves: ['login-new-user'],
      title: 'The app session is the test user at its new address',
      async run(ctx) {
        await ctx.ui.goto('/');
        const email = await sessionEmail(ctx.page);
        if (email !== IDS.email.devTestUser || TEST_USER_EMAIL !== IDS.email.devTestUser)
          throw new Error(`the session is ${email ?? '?'}, not identifiers.json's test user`);
        if (!email.endsWith(`@${IDS.domains.dev}`))
          throw new Error(`${email} is not on the dev subdomain`);
        ctx.log(`session: the test user on @${IDS.domains.dev}`);
      },
    },
    {
      id: 'mcp-session',
      entry: 'mcp',
      proves: ['mcp-new-user'],
      title: 'The /mcp session is the same user and partition',
      // The MCP login checks its token's email against the test user (mcp-login.ts) before any call.
      async run(ctx) {
        const ids = (xs: { id: string }[]) =>
          xs
            .map((x) => x.id)
            .sort()
            .join();
        const [viaMcp, viaApi] = [
          await ctx.mcp.reads.listBacklog(),
          await ctx.api.reads.listBacklog(),
        ];
        if (ids(viaMcp) !== ids(viaApi)) throw new Error('MCP and the API list different backlogs');
        ctx.log(`mcp: backlog ${viaMcp.length}, same as the API`);
      },
    },
    {
      id: 'about',
      entry: 'ui',
      proves: ['page-about'],
      title: '/about.html is filled from identifiers.json',
      run: (ctx) => page(ctx, '/about.html', /^Aperture$/),
    },
    {
      id: 'privacy',
      entry: 'ui',
      proves: ['page-privacy'],
      title: '/privacy.html is filled from identifiers.json',
      run: (ctx) => page(ctx, '/privacy.html', /Privacy Policy/),
    },
    noConsoleErrors,
  ],
};
