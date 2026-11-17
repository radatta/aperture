// LeetCode sittings (docs/areas/recruiting), PR A1: the server half the extension will call — Start opens a
// sitting as a rep of the linked roll, events fold into it, Done or Drop on the rep ends it — and the
// Recruiting page and Settings reading it back. PR B: Claude's live pull. PR C: a sitting's page (timeline,
// review, the Haiku draft, End sitting), Home's link to it, and get_sitting / list_sittings. Driven through the JWT: the device token writes into the
// user's own dev partition, not the test user's, so its gate is proven off dev (lambdas index.test.ts).
// Slugs and titles carry the run's nonce; every row this scenario makes is ledgered from a response.
import { datesFor, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import type { DevSittingReview } from '../api';
import type { DevSittingEvent, DevSittingStart } from '../api';
import { McpRpcError, PARAM_ERROR } from '../mcp';
import { devUlid } from './flux-history';

const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const slugOf = (ctx: Ctx, which: string) => `devcheck-lc-${tag(ctx)}-${which}`;
const titleOf = (ctx: Ctx, which: string) => `devcheck-lc ${ctx.nonce} ${which}`;
const start = (ctx: Ctx, which: string, over: Partial<DevSittingStart> = {}): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slugOf(ctx, which),
  problemTitle: titleOf(ctx, which),
  difficulty: 'Medium',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
  // The fields a real questionDetail doc carries that get_sitting reads (synthetic values).
  problem: {
    titleSlug: slugOf(ctx, which),
    difficulty: 'Medium',
    content: '<p>devcheck <code>statement</code></p>',
    companyTagStatsV2: '{"three_months":[{"name":"Acme","timesEncountered":3}]}',
  },
  ...over,
});
const snap = (code: string, at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'snapshot',
  at,
  payload: { code, lang: 11 },
});
const judged = (
  type: 'run' | 'submit',
  status: number,
  msg: string,
  at: number,
  ok: number,
  all: number,
  extra: Record<string, unknown> = {}, // more /check/ fields: the failing case
): DevSittingEvent => ({
  id: devUlid(),
  type,
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result: {
      status_code: status,
      status_msg: msg,
      total_correct: ok,
      total_testcases: all,
      ...extra,
    },
  },
});
const review = (over: Partial<DevSittingReview> = {}): DevSittingReview => ({
  insight: null,
  help: 'none',
  mistakes: [],
  howItWent: null,
  tags: [],
  draftUsed: false,
  ...over,
});
const sittingLink = (ctx: Ctx, which: string) =>
  ctx.page.getByRole('link', {
    name: new RegExp(titleOf(ctx, which).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  });
// The computed font-size of every field inside a container, in px — iOS Safari zooms one under 16.
const fieldSizes = (ctx: Ctx, container: string) =>
  ctx.page.evaluate<number[]>(
    `[...document.querySelectorAll(${JSON.stringify(container)} + ' input:not([type=checkbox]), ' + ${JSON.stringify(container)} + ' textarea')].map((e) => parseFloat(getComputedStyle(e).fontSize))`,
  );
// The server's refusal, as call() throws it: `<method> → HTTP 400: {"error":"…"}`.
async function refused(what: string, p: Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/HTTP 400/.test(msg) || !match.test(msg))
      throw new Error(`${what}: refused oddly — ${msg}`, { cause: err });
    return;
  }
  throw new Error(`${what}: not refused`);
}

// What later steps build on, set by the steps that make it.
const state = {
  rollId: '',
  a: '',
  aRep: '',
  aClient: '',
  aStartedAt: 0,
  aNewestAt: 0, // the latest `at` sent on A: live and `last` are the newest by `at` (see nextAt)
  aBeforeDone: 0, // a stamp taken just before Done on A
  aDoneAt: 0, // this machine's clock when Done on A returned
  c: '',
  cBeforeDrop: 0, // a stamp taken just before C's drop
  d: '',
  dRep: '',
  dStartedAt: 0,
};
// A time after everything already sent on A. The events step stamps its batch up to 6 s ahead of the clock, so on a
// fast run (the local check) a plain Date.now() is still behind it, and live and `last` — the newest by `at` —
// would rightly keep the older event. Dev's round trips hid that.
const nextAt = () => (state.aNewestAt = Math.max(Date.now(), state.aNewestAt + 1));
async function sittingA(ctx: Ctx) {
  if (!state.a) throw new Error('no sitting A — the start step failed');
  return ctx.api.reads.getSitting(state.a);
}

export const lcSittings: Scenario = {
  id: 'lc-sittings',
  title: 'A LeetCode sitting opens as a rep, folds its runs and submits, and ends with the rep',
  tiers: ['full'],
  slowPaths: [
    'app/src/pages/Recruiting/**',
    'app/src/data/hooks/useSittings.ts',
    'app/src/pages/Settings/index.tsx',
    'packages/shared/src/sittings.ts',
    'scripts/src/devcheck/scenarios/lc-sittings.ts',
    'lambdas/src/anthropic/sittingReviewPrompt.ts',
    'app/src/pages/Home/RightNowCard.tsx',
  ],
  rows: [
    // PR B: Claude watches live (live_sitting, lambdas/src/mcp/leetcodeTools.ts).
    {
      id: 'live-listed',
      entry: 'mcp',
      kind: 'nominal',
      what: 'MCP offers live_sitting',
    },
    {
      id: 'live-idle',
      entry: 'mcp',
      kind: 'nominal',
      what: 'With nothing open, live_sitting says so',
    },
    {
      id: 'live-active',
      entry: 'mcp',
      kind: 'nominal',
      what: 'During a sitting, live_sitting returns its newest code in full, the snapshot version, the problem, the newest Submit’s verdict and the counts',
    },
    {
      id: 'live-counted',
      entry: 'api',
      kind: 'nominal',
      what: 'The sitting read shows the pull counted (Claude watched live)',
    },
    {
      id: 'live-repeat',
      entry: 'mcp',
      kind: 'edge',
      what: 'A second pull with sinceVersion at the current version says the code is unchanged, and counts again',
    },
    {
      id: 'live-bad-arg',
      entry: 'mcp',
      kind: 'edge',
      what: 'A sinceVersion that isn’t a whole number is a param error, and nothing is counted',
    },
    {
      id: 'live-after-done',
      entry: 'mcp',
      kind: 'edge',
      what: 'After Done on the rep, live_sitting is inactive and names that sitting as the last one, done',
    },
    {
      id: 'live-stale',
      entry: 'mcp',
      kind: 'edge',
      what: 'A sitting left open past its window reads inactive, with nothing written',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'nothing open — none ever, the gate on an ended one, or past the window — writes nothing',
        why: 'dev can’t wait a day; the same pull path is proven on dev by live-active and live-after-done',
      },
    },
    {
      id: 'live-big-code',
      entry: 'mcp',
      kind: 'edge',
      what: 'Code at the 64 KB snapshot cap comes back whole through MCP',
    },
    {
      id: 'live-race',
      entry: 'mcp',
      kind: 'edge',
      what: 'Pulls racing a run’s ingest all count, the run still folds, and its failing case comes back',
    },
    // lc-polish: a Run's verdict from correct_answer, its answer over its prints, the code's language by name,
    // and the problem statement read back.
    {
      id: 'run-wrong',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A Run LeetCode calls Accepted (it ran) with correct_answer false reads as Wrong Answer in live_sitting and get_sitting, with its answer as the output, not its prints',
    },
    {
      id: 'run-wrong-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'The sitting’s page shows that Run as “Wrong Answer · 0/2”, never “Accepted”',
    },
    {
      id: 'run-outcome',
      entry: 'mcp',
      kind: 'edge',
      what: 'A wrong Run leaves the outcome (submits only) as it was',
    },
    {
      id: 'run-right',
      entry: 'mcp',
      kind: 'edge',
      what: 'A Run with correct_answer true stays Accepted (and false is Wrong Answer, said so)',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'correct_answer false is a wrong answer, said so; true stays accepted',
        why: 'same path as run-wrong (proven on dev): only verdictOf’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'run-no-flag',
      entry: 'mcp',
      kind: 'edge',
      what: 'A Run LeetCode calls Accepted with no correct_answer is Wrong Answer when fewer passed than ran, else Accepted',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'with no flag, fewer passed than run is wrong and all passed is accepted',
        why: 'same path as run-wrong (proven on dev): only verdictOf’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'run-errored-submit',
      entry: 'mcp',
      kind: 'edge',
      what: 'An errored Run (correct_answer false) stays a Runtime Error, and a Submit with correct_answer false stays Accepted',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'an errored Run and a Submit are left as LeetCode judged them',
        why: 'same path as run-wrong (proven on dev): only verdictOf’s pure decision differs, run entirely in the named test',
      },
    },
    {
      id: 'run-old-row',
      entry: 'mcp',
      kind: 'edge',
      what: 'A Run stored before the rule (its head row folded as Accepted) reads as Wrong Answer in live_sitting: the payload in hand decides',
      offDev: {
        file: 'lambdas/src/mcp/leetcodeTools.test.ts',
        test: 'a head row folded under the old rule is read past: the payload in hand decides',
        why: 'dev folds every new head row under the new rule, so it can’t make an old one; the test writes one over the real handler path',
      },
    },
    {
      id: 'code-lang',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The code’s language reads by name (Python3), not LeetCode’s id 11, in live_sitting and get_sitting',
    },
    {
      id: 'code-lang-unknown',
      entry: 'mcp',
      kind: 'edge',
      what: 'An id LeetCode’s list doesn’t name falls back to the sitting’s own language',
      offDev: {
        file: 'lambdas/src/mcp/leetcodeTools.test.ts',
        test: 'names the code’s language from LeetCode’s id, else the sitting’s',
        why: 'same path as code-lang (proven on dev): only lcLangName’s pure lookup differs',
      },
    },
    {
      id: 'code-lang-text',
      entry: 'mcp',
      kind: 'edge',
      what: 'A language that is text, not an id, passes through as it came',
      offDev: {
        file: 'packages/shared/src/leetcode.test.ts',
        test: 'names LeetCode’s numeric language ids, passes text through, and has no name for an unknown id',
        why: 'same path as code-lang (proven on dev): only lcLangName’s pure lookup differs, run entirely in the named test',
      },
    },
    {
      id: 'get-statement',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_sitting carries the problem statement as text and the companies from the Start’s problem doc',
    },
    {
      id: 'live-real',
      entry: 'mcp',
      kind: 'nominal',
      what: 'In a real sitting on prod, Claude (the Aperture project) answers “what am I working on?” from live_sitting',
      needsYou:
        'needs the Safari extension (PR A2) on prod and the claude.ai connector reconnected — your first real sitting after both',
    },
    {
      id: 'start-unlinked',
      entry: 'api',
      kind: 'edge',
      what: 'Start with no LeetCode roll linked is refused and writes nothing',
    },
    {
      id: 'start-spawn',
      entry: 'api',
      kind: 'nominal',
      what: 'Start spawns a rep in progress, titled after the problem, on today’s plan, with the problem stored',
    },
    {
      id: 'start-resume',
      entry: 'api',
      kind: 'edge',
      what: 'A repeated Start, or one on the same open problem, resumes the sitting',
    },
    {
      id: 'start-other-refused',
      entry: 'api',
      kind: 'edge',
      what: 'Start on another problem while one is open is refused',
    },
    {
      id: 'events-fold',
      entry: 'api',
      kind: 'nominal',
      what: 'Snapshots version the live code; a run and a wrong-then-accepted submit fold into the metrics',
    },
    {
      id: 'events-repeat',
      entry: 'api',
      kind: 'edge',
      what: 'Sending the same events again counts them as duplicates, nothing double-counted',
    },
    // lc-coach C0: the extension's coach events (trace card, resubmit nudge) fold into summary.coach.
    {
      id: 'coach-fold',
      entry: 'api',
      kind: 'nominal',
      what: 'Coach events (config, an untraced submit, a nudge) fold into the sitting’s coaching; a repeat is a duplicate',
    },
    {
      id: 'coach-after-submit',
      entry: 'api',
      kind: 'edge',
      what: 'A trace sent after the first submit leaves the trace state as it stood at that submit',
    },
    {
      id: 'coach-too-big',
      entry: 'api',
      kind: 'edge',
      what: 'A coach event over 4 KB is refused, with nothing written',
    },
    {
      id: 'coach-trace-states',
      entry: 'api',
      kind: 'edge',
      what: 'Before the first submit, three inputs traced is traced, one or two partial, none or a skip skipped, the latest winning',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'three inputs before the first submit is traced; one or two partial; none or a skip, skipped',
        why: 'same path as coach-fold (proven on dev): the same ingest and refold, only the fold’s input differs',
      },
    },
    {
      id: 'coach-unknown-kind',
      entry: 'api',
      kind: 'edge',
      what: 'A coach event of a kind the server doesn’t know is stored and folds nothing',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'nudges count, the config is the latest readable one, and an unknown kind folds nothing',
        why: 'same path as coach-fold (proven on dev): the same ingest and refold, only the fold’s input differs',
      },
    },
    {
      id: 'events-invalid',
      entry: 'api',
      kind: 'edge',
      what: 'Oversized, too many, badly-keyed or unknown-sitting events are refused with nothing written',
    },
    {
      id: 'replay',
      entry: 'api',
      kind: 'nominal',
      what: 'A replay chunk is stored raw, kept out of the sitting read, and folds into its facts',
    },
    {
      id: 'end-done',
      entry: 'api',
      kind: 'nominal',
      what: 'Done on the rep ends the sitting',
    },
    {
      id: 'end-drop',
      entry: 'api',
      kind: 'edge',
      what: 'Dropping a rep abandons its sitting',
    },
    // The grace: what the extension stamped before Done still lands for ten minutes after it.
    {
      id: 'late-before',
      entry: 'api',
      kind: 'nominal',
      what: 'An event stamped before Done, sent after it, lands; its resend is a duplicate',
    },
    {
      id: 'late-after',
      entry: 'api',
      kind: 'edge',
      what: 'An event stamped after Done is skipped, with nothing written',
    },
    {
      id: 'late-mixed',
      entry: 'api',
      kind: 'edge',
      what: 'A batch of both keeps the ones stamped before Done',
    },
    {
      id: 'grace-over',
      entry: 'api',
      kind: 'edge',
      what: 'Ten minutes after Done, even an event stamped before it is refused',
    },
    {
      id: 'late-drop',
      entry: 'api',
      kind: 'edge',
      what: 'A dropped sitting takes the events stamped before the drop the same',
    },
    {
      id: 'late-budget',
      entry: 'api',
      kind: 'edge',
      what: 'A late call reserves only its kept events in the sitting’s capture budget, and leaves the open neighbour’s gate',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'late events write only the ended sitting’s rows',
        why: 'the budget row isn’t readable through the API, and the gate only through a live pull, which writes a count',
      },
    },
    {
      id: 'late-window',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting ended by a Start past its window takes no late events',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'after its end a sitting takes events for ten minutes, inside its window only',
        why: 'dev can’t wait a day',
      },
    },
    {
      id: 'late-neighbour',
      entry: 'api',
      kind: 'edge',
      what: 'A late call to an ended sitting leaves an open neighbour’s head and live row as they were',
    },
    {
      id: 'ui-open',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Recruiting page pins the open sitting with its running clock',
    },
    {
      id: 'ui-ended',
      entry: 'ui',
      kind: 'nominal',
      what: 'After a reload, ended sittings read by day with their outcome (accepted on submit 2, dropped)',
    },
    {
      id: 'ui-neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'The Stories tab beside Sittings still opens',
    },
    {
      id: 'settings-select',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings shows the linked LeetCode roll; picking No Roll and back saves each',
    },
    {
      id: 'device-token',
      entry: 'api',
      kind: 'nominal',
      what: 'The extension’s device token starts a sitting as its user, and opens nothing else',
      offDev: {
        file: 'lambdas/src/index.test.ts',
        test: 'the device token starts a sitting as DEVICE_USER_ID',
        why: 'dev can’t produce it for the test user: the device token writes into its own user’s partition',
      },
    },
    {
      id: 'raw-expiry',
      entry: 'api',
      kind: 'nominal',
      what: 'Only the raw bulk (snapshots, replay, submit details) is stamped to expire',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'stamps expiresAt on the raw bulk only, on prod',
        why: 'dev can’t show it: expiresAt is a table attribute no API read returns',
      },
    },
    {
      id: 'double-start',
      entry: 'api',
      kind: 'edge',
      what: 'A double-fired Start makes one sitting and one rep',
    },
    {
      id: 'prep-target',
      entry: 'api',
      kind: 'nominal',
      what: 'A sitting’s prep target saves trimmed, and blank goes back to General',
    },
    {
      id: 'delete-sitting',
      entry: 'api',
      kind: 'edge',
      what: 'Deleting a sitting removes it and its reads, and leaves its rep',
    },
    {
      id: 'event-clock',
      entry: 'api',
      kind: 'edge',
      what: 'An event timed days off the sitting’s clock is refused',
    },
    {
      id: 'start-archived',
      entry: 'api',
      kind: 'edge',
      what: 'A linked roll that’s been archived reads as unlinked',
    },
    {
      id: 'stale-window',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting left open past its window ends at the next Start, which reuses its rep',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'abandons one past its window and reuses its still-open rep',
        why: 'dev can’t wait a day; the planner is pure, and this unit test runs it past the window',
      },
    },
    {
      id: 'half-made',
      entry: 'api',
      kind: 'edge',
      what: 'A Start that died half-way finishes on its retry, and blocks another problem only while it could still be in flight',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'a half-made Start finishes on its retry, and never blocks another problem',
        why: 'dev can’t make a Start die between its head and its rep without a test-only switch',
      },
    },
    {
      id: 'parallel-starts',
      entry: 'api',
      kind: 'edge',
      what: 'Parallel Starts on different problems open one sitting; the other is refused as still open',
    },
    {
      id: 'delete-cascade',
      entry: 'api',
      kind: 'edge',
      what: 'Deleting a rep removes its sitting — runs, submits and all',
    },
    {
      id: 'attempt-cap',
      entry: 'api',
      kind: 'edge',
      what: 'Start attempts — refused ones too — stop at the day’s cap',
      offDev: {
        file: 'lambdas/src/backend.sittings.test.ts',
        test: 'counts every Start attempt — refused ones too — and stops at the day’s cap',
        why: 'dev can’t take 400 Starts without locking the test user out for the day',
      },
    },
    {
      id: 'cap',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting past 3,000 events — any type, repeats included — refuses more with nothing written',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'reserves a call in the budget, refusing one that would pass a cap',
        why: 'dev can’t take it: 3,000 writes would run into dev’s write cap; the guard is this pure reservation',
      },
    },
    {
      id: 'mcp-legacy-gone',
      entry: 'mcp',
      kind: 'edge',
      what: 'MCP no longer offers list_leetcode_attempts',
    },
    {
      id: 'window',
      entry: 'api',
      kind: 'edge',
      what: 'Events a day after Start are refused',
      offDev: {
        file: 'packages/shared/src/sittings.test.ts',
        test: 'refuses a sitting past its grace or its window, and an event off its clock',
        why: 'dev can’t wait a day: the guard is pure, and the contract suite runs it with an advanced clock',
      },
    },
    // PR C: a sitting's page, its review and the Haiku draft, End sitting, Home's link, and reading it back.
    {
      id: 'det-timeline',
      entry: 'ui',
      kind: 'nominal',
      what: 'A sitting’s page lists every Run and Submit with its verdict, the wrong submit’s failing case, and a code-changed marker; the same after a reload',
    },
    {
      id: 'det-metrics',
      entry: 'ui',
      kind: 'nominal',
      what: 'The page reads the outcome (“accepted on submit 2”) and “Claude watched live · 9 pulls”',
    },
    {
      id: 'det-unknown',
      entry: 'ui',
      kind: 'edge',
      what: 'An unknown sitting id reads “No such sitting.” with the way back',
    },
    {
      id: 'rev-save',
      entry: 'ui',
      kind: 'nominal',
      what: 'The review form starts on a hint after a failed submit; one-liner, a mistake, a tag and how it went save and read back after a reload; the list row shows the reviewed dot',
    },
    {
      id: 'rev-fields-16px',
      entry: 'ui',
      kind: 'edge',
      what: 'Every review field renders at 16px or more (iOS Safari zooms one under 16)',
    },
    {
      id: 'rev-api',
      entry: 'api',
      kind: 'nominal',
      what: 'setSittingReview folds whitespace, lowercases and dedupes tags; getSitting and listSittings carry it',
    },
    {
      id: 'rev-invalid',
      entry: 'api',
      kind: 'edge',
      what: '9 mistakes, a 201-character one-liner, or an unknown help level is refused with the head unchanged',
    },
    {
      id: 'rev-repeat',
      entry: 'api',
      kind: 'edge',
      what: 'A second review replaces the first; an all-empty one clears it to null',
    },
    {
      id: 'rev-ownership',
      entry: 'api',
      kind: 'edge',
      what: 'A review or a draft for a sitting id that isn’t the user’s is Not found, nothing written',
    },
    {
      id: 'rev-refold',
      entry: 'api',
      kind: 'edge',
      what: 'A review on an open sitting survives a later run’s refold of the head',
    },
    {
      id: 'draft-real',
      entry: 'api',
      kind: 'nominal',
      what: 'The real Haiku draft on A answers one to five lines of at most 160 characters, and writes nothing',
    },
    {
      id: 'draft-nothing',
      entry: 'api',
      kind: 'edge',
      what: 'A draft with nothing judged yet answers nothing-to-draft without a model call',
    },
    {
      id: 'draft-bad-shape',
      entry: 'api',
      kind: 'edge',
      what: 'A model answer that isn’t a list of text is bad-shape, nothing written',
      offDev: {
        file: 'lambdas/src/backend.sittingDraft.test.ts',
        test: 'a bad shape is refused and nothing is written',
        why: 'dev can’t make Haiku misbehave on demand; the test runs the real backend over the Fake gateway',
      },
    },
    {
      id: 'draft-fit',
      entry: 'api',
      kind: 'edge',
      what: 'A model answer with too many or too long lines is cut to fit (first 5, each ≤ 160 ending “…”), nothing written',
      offDev: {
        file: 'lambdas/src/backend.sittingDraft.test.ts',
        test: 'too many or too long lines are cut to fit, not refused',
        why: 'dev can’t make Haiku over-answer on demand; the test runs the real backend over the Fake gateway',
      },
    },
    {
      id: 'draft-noop',
      entry: 'api',
      kind: 'edge',
      what: 'A smoke (testMode) call never reaches the model',
      offDev: {
        file: 'lambdas/src/backend.sittingDraft.test.ts',
        test: 'a smoke run spends nothing: testMode never reaches the model',
        why: 'dev can’t see whether the model was called — only the answer, which the noop and an outage share',
      },
    },
    {
      id: 'draft-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'Draft with Claude (a canned two-line reply) adds unticked editable lines; one ticked and edited is saved, marked draftUsed; Use all ticks every line',
    },
    {
      id: 'draft-fail',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed draft (HTTP 500) says so inline, keeps the typed mistake, and Save still saves',
    },
    {
      id: 'get-latest',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_sitting with no id reads the newest sitting (C: no runs, no review)',
    },
    {
      id: 'get-id',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_sitting {id: A}: the timeline with the wrong submit’s case, the final code, the review',
    },
    {
      id: 'get-unknown',
      entry: 'mcp',
      kind: 'edge',
      what: 'get_sitting with a foreign id is Not found; a malformed one is a param error',
    },
    {
      id: 'list-range',
      entry: 'mcp',
      kind: 'nominal',
      what: 'list_sittings for today lists C then A, A reviewed with its tags; limit 1 is C alone, with more',
    },
    {
      id: 'list-empty',
      entry: 'mcp',
      kind: 'edge',
      what: 'list_sittings for a month long past is empty',
    },
    {
      id: 'list-bad',
      entry: 'mcp',
      kind: 'edge',
      what: 'list_sittings refuses limit "5", limit 0, from without to, from after to, and a non-date',
    },
    {
      id: 'end-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'End sitting on D opens its rep’s Done prefilled with D’s minutes; Mark done ends D, and live_sitting then names it, done',
    },
    {
      id: 'end-cancel',
      entry: 'ui',
      kind: 'edge',
      what: 'End sitting → Cancel writes nothing: D stays open',
    },
    {
      id: 'home-link',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home shows “End the LeetCode sitting →” on D’s rep, and it opens D’s page',
    },
    {
      id: 'home-neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'Another task in progress on Home gets no link: exactly one on the page',
    },
    {
      id: 'home-prefill',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s Done on a LeetCode rep with an open sitting starts on the sitting’s minutes',
    },
    {
      id: 'home-minutes',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home shows the open sitting’s minutes (at least 1) on D’s rep, as the hero and as a row under a planned neighbour — not the rep’s own 0m',
    },
    {
      id: 'prefill-estimate',
      entry: 'ui',
      kind: 'edge',
      what: 'A rep that lost its estimate: Home’s Done and End sitting both offer the Roll’s 45 as the estimate in hindsight',
    },
    // PR D: the legacy per-submission write (recordLeetcodeAttempt) is gone.
    {
      id: 'legacy-refused',
      entry: 'api',
      kind: 'edge',
      what: 'The removed recordLeetcodeAttempt gives the signed-in user no API answer, twice alike, and a non-JWT bearer still 401s (the probe sends no input, so nothing can be written)',
    },
    {
      id: 'legacy-jwt-404',
      entry: 'api',
      kind: 'edge',
      what: 'On recordLeetcodeAttempt the real device token 401s and the user’s JWT 404s “Unknown method”; neither touches the table',
      offDev: {
        file: 'lambdas/src/index.test.ts',
        test: 'refuses recordLeetcodeAttempt: 401 with the device token, 404 with a JWT, the table untouched',
        why: 'dev can’t produce it: the dev check holds no device token (it writes into its own user’s partition), and CloudFront serves an origin 404 as index.html with a 200',
      },
    },
  ],
  steps: [
    {
      id: 'live-idle',
      entry: 'mcp',
      proves: ['live-listed', 'live-idle'],
      title: 'MCP lists live_sitting; with nothing open it says inactive',
      async run(ctx) {
        if (!(await ctx.mcp.reads.toolsList()).includes('live_sitting'))
          throw new Error('live_sitting isn’t listed');
        const out = await ctx.mcp.reads.liveSitting();
        if (out.active) throw new Error(`active with nothing open: ${JSON.stringify(out.sitting)}`);
        if (out.lastSitting?.problem.slug.includes(tag(ctx)))
          throw new Error('lastSitting is one of this run’s, before any Start');
      },
    },
    {
      id: 'unlinked',
      entry: 'api',
      proves: ['start-unlinked'],
      title: 'Unlink any LeetCode roll, then Start — refused, no sitting',
      async run(ctx) {
        await ctx.api.writes.linkLeetcodeRoll(null);
        await refused(
          'unlinked start',
          ctx.api.writes.lcSittingStart(start(ctx, 'none')),
          /LeetCode roll/,
        );
        const mine = (await ctx.api.reads.listSittings()).filter(
          (x) => x.problemSlug === slugOf(ctx, 'none'),
        );
        if (mine.length) throw new Error('the refused Start left a sitting');
      },
    },
    {
      id: 'start',
      entry: 'api',
      proves: ['start-spawn', 'start-resume', 'start-other-refused'],
      title: 'Link a fresh roll; Start A spawns its rep; repeats resume; Start B is refused',
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'roll'),
          estimateMin: 45,
        });
        state.rollId = roll.id;
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        const input = start(ctx, 'a');
        const { sitting, resumed } = await ctx.api.writes.lcSittingStart(input);
        if (resumed || sitting.status !== 'active')
          throw new Error(`start: ${JSON.stringify(sitting)}`);
        Object.assign(state, {
          a: sitting.id,
          aRep: sitting.repTaskId,
          aClient: input.clientSittingId,
          aStartedAt: input.startedAt,
        });
        const rep = await ctx.api.reads.getTask(sitting.repTaskId);
        if (rep?.status !== 'in_progress' || rep.title !== `LeetCode · ${titleOf(ctx, 'a')}`)
          throw new Error(`rep: ${JSON.stringify(rep)}`);
        const plans = await ctx.api.reads.listPlansForDay(sitting.day);
        if (!plans.some((p) => p.taskId === rep.id))
          throw new Error('the rep isn’t on the sitting’s day');
        if ((await sittingA(ctx)).problem?.slug !== slugOf(ctx, 'a'))
          throw new Error('no problem stored');
        const again = await ctx.api.writes.lcSittingStart({
          ...input,
          problemTitle: 'devcheck hijack',
        });
        const same = await ctx.api.writes.lcSittingStart(
          start(ctx, 'a', { problemTitle: 'hijack 2' }),
        );
        for (const r of [again, same])
          if (!r.resumed || r.sitting.id !== sitting.id)
            throw new Error(`resume: ${JSON.stringify(r)}`);
        // A repeat shapes the rep from the stored sitting: a different title in the request renames nothing.
        if ((await ctx.api.reads.getTask(rep.id))?.title !== `LeetCode · ${titleOf(ctx, 'a')}`)
          throw new Error('a repeated Start renamed the rep');
        await refused(
          'start B while A is open',
          ctx.api.writes.lcSittingStart(start(ctx, 'b')),
          /still open/,
        );
      },
    },
    {
      id: 'draft-nothing',
      entry: 'api',
      proves: ['draft-nothing'],
      title: 'A draft on A before anything is judged: nothing-to-draft, no model call',
      async run(ctx) {
        const out = await ctx.api.reads.draftSittingReview(state.a);
        if (out.ok || out.reason !== 'nothing-to-draft')
          throw new Error(`draft: ${JSON.stringify(out)}`);
      },
    },
    {
      id: 'events',
      entry: 'api',
      proves: ['events-fold', 'events-repeat'],
      title:
        'Two snapshots and an older one, a run, a wrong submit, an accepted one; then all again',
      async run(ctx) {
        const t = Date.now();
        state.aNewestAt = t + 6000; // this batch runs up to 6 s ahead of the clock
        const batch = [
          snap('class Solution: pass', t + 1000),
          snap('class Solution:\n    def solve(self): ...', t + 3000),
          snap('stale', t + 2000),
          judged('run', 15, 'Runtime Error', t + 4000, 0, 3),
          judged('submit', 11, 'Wrong Answer', t + 5000, 88, 307, {
            last_testcase: '[3,3]\n6',
            expected_output: '[0,1]',
            code_output: '[]',
          }),
          judged('submit', 10, 'Accepted', t + 6000, 307, 307),
        ];
        const first = await ctx.api.writes.lcSittingEvents(state.a, batch);
        if (first.accepted !== 6 || first.version !== 3 || first.status !== 'active')
          throw new Error(`first: ${JSON.stringify(first)}`);
        const again = await ctx.api.writes.lcSittingEvents(state.a, batch);
        if (again.accepted !== 0 || again.duplicates !== 6)
          throw new Error(`again: ${JSON.stringify(again)}`);
        const { sitting, live, events } = await sittingA(ctx);
        const s = sitting.summary;
        if (
          s.runs !== 1 ||
          s.submits !== 2 ||
          s.runsBeforeFirstSubmit !== 1 ||
          s.firstSubmit?.verdict !== 'wrong_answer' ||
          s.firstSubmit.passed !== 88 ||
          s.lastSubmit?.verdict !== 'accepted' ||
          s.submitsBeforeAccepted !== 1
        )
          throw new Error(`summary: ${JSON.stringify(s)}`);
        if (live?.version !== 3 || live.code !== 'class Solution:\n    def solve(self): ...')
          throw new Error(`live: ${JSON.stringify(live)}`);
        if (events.length !== 6) throw new Error(`${events.length} events stored, not 6`);
      },
    },
    {
      id: 'coach',
      entry: 'api',
      proves: ['coach-fold', 'coach-after-submit', 'coach-too-big'],
      title:
        'Coach events on A after its submits: the config, an untraced submit, a nudge, a late trace; then again; then one too big',
      async run(ctx) {
        const coach = (payload: unknown): DevSittingEvent => ({
          id: devUlid(),
          type: 'coach',
          at: nextAt(),
          payload,
        });
        const batch = [
          coach({ kind: 'config', trace: true, hold: true, nudge: true }),
          coach({ kind: 'untraced-submit' }),
          coach({ kind: 'nudge-shown', gapMs: 30_000 }),
          coach({
            kind: 'trace',
            inputs: { empty: '[]', boundary: '[1]', normal: '[2,1]' },
            ms: 1,
          }),
        ];
        const first = await ctx.api.writes.lcSittingEvents(state.a, batch);
        if (first.accepted !== 4) throw new Error(`first: ${JSON.stringify(first)}`);
        const again = await ctx.api.writes.lcSittingEvents(state.a, batch);
        if (again.accepted !== 0 || again.duplicates !== 4)
          throw new Error(`again: ${JSON.stringify(again)}`);
        const before = (await sittingA(ctx)).sitting.summary;
        const c = before.coach; // field by field: a stored map's key order isn't kept
        if (
          c?.trace !== 'none' ||
          c.nudges !== 1 ||
          c.config?.trace !== true ||
          c.config.hold !== true ||
          c.config.nudge !== true
        )
          throw new Error(`coach: ${JSON.stringify(c)}`);
        const big = coach({ kind: 'trace-skip', pad: 'x'.repeat(4200) });
        await refused(
          'a coach event over 4 KB',
          ctx.api.writes.lcSittingEvents(state.a, [big]),
          /too large/,
        );
        const after = (await sittingA(ctx)).sitting.summary;
        if (after.headEvents !== before.headEvents)
          throw new Error(`headEvents ${before.headEvents} → ${after.headEvents} after a refusal`);
      },
    },
    {
      id: 'live-active',
      entry: 'mcp',
      proves: ['live-active', 'code-lang'],
      title:
        'live_sitting during A: its newest code, version 3, in Python3, the problem, the accepted submit, the counts',
      async run(ctx) {
        const out = await ctx.mcp.reads.liveSitting();
        if (
          !out.active ||
          out.sitting?.id !== state.a ||
          out.sitting.problem.slug !== slugOf(ctx, 'a') ||
          out.sitting.liveReads !== 1 ||
          out.code?.version !== 3 ||
          out.code.text !== 'class Solution:\n    def solve(self): ...' ||
          out.code.lang !== 'Python3' ||
          out.runCount !== 1 ||
          out.submitCount !== 2 ||
          out.lastSubmit?.verdict !== 'accepted' ||
          'unchangedSinceVersion' in out
        )
          throw new Error(`live: ${JSON.stringify({ ...out, code: out.code?.version })}`);
      },
    },
    {
      id: 'live-counted',
      entry: 'api',
      proves: ['live-counted'],
      title: 'The sitting read shows the one pull',
      async run(ctx) {
        const { liveReads } = await sittingA(ctx);
        if (liveReads !== 1) throw new Error(`liveReads ${liveReads}, not 1`);
      },
    },
    {
      id: 'live-repeat',
      entry: 'mcp',
      proves: ['live-repeat', 'live-bad-arg'],
      title:
        'A pull with sinceVersion 3 says unchanged and counts; sinceVersion "3" is refused, uncounted',
      async run(ctx) {
        const out = await ctx.mcp.reads.liveSitting({ sinceVersion: 3 });
        if (out.unchangedSinceVersion !== true || out.sitting?.liveReads !== 2)
          throw new Error(
            `repeat: ${JSON.stringify({ u: out.unchangedSinceVersion, n: out.sitting?.liveReads })}`,
          );
        try {
          await ctx.mcp.reads.liveSitting({ sinceVersion: '3' });
          throw new Error('sinceVersion "3" was taken');
        } catch (err) {
          if (!(err instanceof McpRpcError) || err.code !== PARAM_ERROR) throw err;
        }
        const { liveReads } = await sittingA(ctx);
        if (liveReads !== 2) throw new Error(`the refused pull counted: liveReads ${liveReads}`);
      },
    },
    {
      id: 'invalid',
      entry: 'api',
      proves: ['events-invalid', 'event-clock'],
      title:
        'Off-clock, oversized, 51, badly-keyed and unknown-sitting events are all refused; the live row is unchanged',
      async run(ctx) {
        const t = Date.now();
        const w = ctx.api.writes;
        await refused(
          'oversized',
          w.lcSittingEvents(state.a, [snap('x'.repeat(70 * 1024), t)]),
          /too large/,
        );
        await refused(
          'an event three days off the sitting’s clock',
          w.lcSittingEvents(state.a, [snap('a', state.aStartedAt + 3 * 24 * 3600_000)]),
          /off the sitting/,
        );
        const many = Array.from({ length: 51 }, (_, i) => snap('a', t + i));
        await refused('51 events', w.lcSittingEvents(state.a, many), /At most 50/);
        await refused(
          'bad id',
          w.lcSittingEvents(state.a, [{ ...snap('a', t), id: 'nope' }]),
          /valid id/,
        );
        await refused(
          'unknown sitting',
          w.lcSittingEventsToUnknown(devUlid(), [snap('a', t)]),
          /Not found/,
        );
        const { live } = await sittingA(ctx);
        if (live?.version !== 3)
          throw new Error(`a refused call moved the live row: v${live?.version}`);
      },
    },
    {
      id: 'live-big',
      entry: 'mcp',
      proves: ['live-big-code'],
      title: 'A snapshot near the 64 KB cap comes back whole from live_sitting',
      async run(ctx) {
        const big = `# devcheck\n${'x'.repeat(63 * 1024)}`;
        await ctx.api.writes.lcSittingEvents(state.a, [snap(big, nextAt())]);
        const out = await ctx.mcp.reads.liveSitting();
        if (out.code?.text !== big || out.code.version !== 4 || out.sitting?.liveReads !== 3)
          throw new Error(
            `big: ${out.code?.text?.length} chars, v${out.code?.version}, ${out.sitting?.liveReads} pulls`,
          );
      },
    },
    {
      id: 'live-race',
      entry: 'mcp',
      proves: ['live-race', 'run-wrong', 'run-outcome'],
      title:
        'Five pulls at once with a run’s ingest: all five count, the run folds as Wrong Answer (LeetCode’s Accepted, correct_answer false), its case and answer come back, the outcome holds',
      async run(ctx) {
        const run: DevSittingEvent = {
          id: devUlid(),
          type: 'run',
          at: nextAt(),
          payload: {
            request: { lang: 'python3', typed_code: 'print("devcheck")', data_input: '[2,7]\n9' },
            // A Run's /check/ as captured 2026-11-08: "Accepted" means it ran; code_output is its prints.
            result: {
              status_code: 10,
              status_msg: 'Accepted',
              correct_answer: false,
              total_correct: 0,
              total_testcases: 2,
              code_answer: ['[0,0]'],
              code_output: ['devcheck print'],
              expected_code_answer: ['[0,1]'],
            },
          },
        };
        await Promise.all([
          ...Array.from({ length: 5 }, () => ctx.mcp.reads.liveSitting()),
          ctx.api.writes.lcSittingEvents(state.a, [run]),
        ]);
        const out = await ctx.mcp.reads.liveSitting();
        const d = out.lastRun?.detail;
        if (
          out.sitting?.liveReads !== 9 ||
          out.runCount !== 2 ||
          out.lastRun?.verdict !== 'wrong_answer' ||
          out.lastRun.statusMsg !== 'Wrong Answer' ||
          out.lastRun.passed !== 0 ||
          out.lastRun.total !== 2 ||
          d?.input !== '[2,7]\n9' ||
          d.expected !== '[0,1]' ||
          d.output !== '[0,0]' ||
          out.outcome?.firstSubmitAccepted !== false ||
          out.outcome.submitsBeforeAccepted !== 1
        )
          throw new Error(
            `race: ${JSON.stringify({ n: out.sitting?.liveReads, runs: out.runCount, last: out.lastRun, outcome: out.outcome })}`,
          );
      },
    },
    {
      id: 'replay',
      entry: 'api',
      proves: ['replay'],
      title: 'One replay chunk: listed raw, absent from the sitting read, folded into the facts',
      async run(ctx) {
        const t = Date.now();
        const raw = JSON.stringify([
          { type: 7, timestamp: t },
          { type: 3, val: true, timestamp: t + 500 },
          { type: 7, timestamp: t + 40_000 },
        ]);
        await ctx.api.writes.lcSittingEvents(state.a, [
          {
            id: devUlid(),
            type: 'replay',
            at: t + 40_000,
            clientSessionId: 'devcheck',
            events: raw,
          },
        ]);
        const { live, events } = await sittingA(ctx);
        if (events.some((e) => e.type === ('replay' as string)))
          throw new Error('the replay is in the sitting read');
        if (
          !live ||
          live.facts.edits < 2 ||
          live.facts.longestStallMs < 39_000 ||
          live.facts.focus.length < 1
        )
          throw new Error(`facts: ${JSON.stringify(live?.facts)}`);
        const chunks = await ctx.api.reads.listSittingReplay(state.a);
        if (!chunks.some((c) => c.events === raw)) throw new Error('the chunk isn’t listed raw');
      },
    },
    {
      id: 'review-api',
      entry: 'api',
      proves: ['rev-api', 'rev-invalid', 'rev-refold', 'rev-repeat', 'rev-ownership'],
      title:
        'Review A while open: normalized on get and list; invalid ones refused; a run keeps it; replace; clear; foreign ids refused',
      async run(ctx) {
        const w = ctx.api.writes;
        const pick = (r: DevSittingReview | null | undefined) =>
          r && JSON.stringify([r.insight, r.help, r.mistakes, r.howItWent, r.tags, r.draftUsed]);
        const want = JSON.stringify([
          'two pointers',
          'hint',
          ['off by one'],
          null,
          ['two-pointers', 'greedy'],
          false,
        ]);
        const saved = await w.setSittingReview(
          state.a,
          review({
            insight: '  two   pointers ',
            help: 'hint',
            mistakes: [' off  by one ', ''],
            tags: ['Two-Pointers', 'two-pointers', ' Greedy '],
          }),
        );
        if (pick(saved.review) !== want) throw new Error(`saved: ${pick(saved.review)}`);
        if (pick((await sittingA(ctx)).sitting.review) !== want)
          throw new Error('getSitting doesn’t carry the review');
        const listed = (await ctx.api.reads.listSittings()).find((x) => x.id === state.a);
        if (pick(listed?.review) !== want) throw new Error('listSittings doesn’t carry the review');
        const bad: [string, DevSittingReview][] = [
          ['9 mistakes', review({ mistakes: Array(9).fill('m') })],
          ['a 201-character one-liner', review({ insight: 'x'.repeat(201) })],
          ['help "cheat"', review({ help: 'cheat' as never })],
        ];
        for (const [what, r] of bad)
          await refused(what, w.setSittingReview(state.a, r), /limited|Help/);
        if (pick((await sittingA(ctx)).sitting.review) !== want)
          throw new Error('a refused review changed the head');
        const runs = (await sittingA(ctx)).sitting.summary.runs;
        await w.lcSittingEvents(state.a, [judged('run', 11, 'Wrong Answer', nextAt(), 0, 1)]);
        const after = (await sittingA(ctx)).sitting;
        if (after.summary.runs !== runs + 1 || pick(after.review) !== want)
          throw new Error(`refold: ${after.summary.runs} runs, review ${pick(after.review)}`);
        const second = await w.setSittingReview(state.a, review({ insight: 'second' }));
        if (second.review?.insight !== 'second' || second.review.tags.length)
          throw new Error(`replace: ${pick(second.review)}`);
        if ((await w.setSittingReview(state.a, review())).review !== null)
          throw new Error('an empty review didn’t clear');
        await refused(
          'a review for a foreign id',
          w.setSittingReviewToUnknown(devUlid(), review({ insight: 'x' })),
          /Not found/,
        );
        await refused(
          'a draft for a foreign id',
          ctx.api.reads.draftSittingReview(devUlid()),
          /Not found/,
        );
      },
    },
    {
      id: 'draft-real',
      entry: 'api',
      cost: 'slow',
      proves: ['draft-real'],
      title: 'The real Haiku draft on A: one to five lines of at most 160 characters; A unchanged',
      async run(ctx) {
        const before = JSON.stringify(await sittingA(ctx));
        let out = await ctx.api.reads.draftSittingReview(state.a);
        // An outage isn't this feature's bug — one more try; a second failure is the row's.
        if (!out.ok && ['timeout', 'network', 'api'].includes(out.reason)) {
          ctx.log(`the real draft failed once (${out.reason}); one more try`);
          out = await ctx.api.reads.draftSittingReview(state.a);
        }
        if (!out.ok) throw new Error(`draft: ${out.reason}`);
        if (
          out.mistakes.length < 1 ||
          out.mistakes.length > 5 ||
          out.mistakes.some((l) => !l.trim() || l.length > 160)
        )
          throw new Error(`draft lines: ${JSON.stringify(out.mistakes)}`);
        ctx.log(`draft: ${JSON.stringify(out.mistakes)}`);
        if (JSON.stringify(await sittingA(ctx)) !== before) throw new Error('the draft wrote');
      },
    },
    {
      id: 'ui-open',
      entry: 'ui',
      cost: 'slow',
      proves: ['ui-open', 'ui-neighbour'],
      title: 'Recruiting pins sitting A as in progress; the Stories tab opens beside it',
      async run(ctx) {
        await ctx.ui.goto('/recruiting');
        const open = ctx.page.getByRole('region', { name: 'Now' });
        await open.getByText(titleOf(ctx, 'a')).waitFor({ timeout: 15_000 });
        await open.getByText(/In progress/).waitFor({ timeout: 5_000 });
        await ctx.shot('sittings-open');
        await ctx.page.getByRole('link', { name: 'Stories' }).click();
        await ctx.page.waitForURL(/\/recruiting\/stories$/, { timeout: 10_000 });
        await ctx.page.getByRole('link', { name: 'Sittings' }).click();
        await open.getByText(titleOf(ctx, 'a')).waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'end',
      entry: 'api',
      proves: ['end-done'],
      title: 'Done on A’s rep ends it',
      async run(ctx) {
        await ctx.api.writes.setTaskActual(state.aRep, 40);
        state.aBeforeDone = nextAt();
        await ctx.api.writes.finishTask(state.aRep, 'done');
        state.aDoneAt = Date.now();
        const a = (await sittingA(ctx)).sitting;
        if (a.status !== 'done' || a.endedAt === null)
          throw new Error(`A after Done: ${JSON.stringify(a)}`);
      },
    },
    {
      id: 'late',
      entry: 'api',
      proves: ['late-before', 'late-after', 'late-mixed'],
      title:
        'After Done, a note stamped before it lands on A (its resend a duplicate); one stamped after is skipped, alone or beside one from before',
      async run(ctx) {
        if (!state.aBeforeDone) throw new Error('no Done on A — the end step failed');
        const w = ctx.api.writes;
        // A note: it moves only the note count, so A's timeline, final code and outcome stay as later steps expect.
        const note = (): DevSittingEvent => ({
          id: devUlid(),
          type: 'note',
          at: state.aBeforeDone,
          payload: { text: 'devcheck late note' },
        });
        // Past the server's 60 s skew allowance (SITTING_END_SKEW_MS — scripts can't import shared).
        const after = () => snap('devcheck after Done', Date.now() + 3 * 60_000);
        const a0 = await sittingA(ctx);
        const rep0 = JSON.stringify(await ctx.api.reads.getTask(state.aRep));
        const kept = note();
        const r1 = await w.lcSittingEvents(state.a, [kept]);
        if (r1.accepted !== 1 || r1.skipped !== 0 || r1.status !== 'done')
          throw new Error(`a note from before Done: ${JSON.stringify(r1)}`);
        const a1 = (await sittingA(ctx)).sitting;
        if (
          a1.summary.notes !== a0.sitting.summary.notes + 1 ||
          a1.status !== 'done' ||
          a1.endedAt !== a0.sitting.endedAt ||
          a1.repTaskId !== state.aRep
        )
          throw new Error(`A after a late note: ${JSON.stringify(a1)}`);
        if (JSON.stringify(await ctx.api.reads.getTask(state.aRep)) !== rep0)
          throw new Error('a late note moved A’s rep');
        const r2 = await w.lcSittingEvents(state.a, [kept]);
        if (r2.accepted !== 0 || r2.duplicates !== 1)
          throw new Error(`the resend: ${JSON.stringify(r2)}`);
        const before = await sittingA(ctx);
        const r3 = await w.lcSittingEvents(state.a, [after()]);
        if (r3.accepted !== 0 || r3.skipped !== 1 || r3.status !== 'done')
          throw new Error(`a snapshot from after Done: ${JSON.stringify(r3)}`);
        if (r3.version !== (before.live?.version ?? 0))
          throw new Error(
            `the skip answered v${r3.version}, A's live row is v${before.live?.version}`,
          );
        if (JSON.stringify(await sittingA(ctx)) !== JSON.stringify(before))
          throw new Error('a skipped event wrote');
        const r4 = await w.lcSittingEvents(state.a, [note(), after()]);
        if (r4.accepted !== 1 || r4.skipped !== 1 || r4.status !== 'done')
          throw new Error(`a mixed batch: ${JSON.stringify(r4)}`);
      },
    },
    {
      id: 'live-after-done',
      entry: 'mcp',
      proves: ['live-after-done'],
      title: 'After Done, live_sitting is inactive and names A as the last sitting, done',
      async run(ctx) {
        const out = await ctx.mcp.reads.liveSitting();
        if (out.active || out.lastSitting?.id !== state.a || out.lastSitting.status !== 'done')
          throw new Error(`after Done: ${JSON.stringify(out)}`);
        if (out.lastSitting.liveReads !== 9)
          throw new Error(`an inactive pull counted: ${out.lastSitting.liveReads}`);
      },
    },
    {
      id: 'ui-detail',
      entry: 'ui',
      cost: 'slow',
      proves: ['det-timeline', 'det-metrics', 'det-unknown', 'run-wrong-ui'],
      title:
        'A’s page from its row: the runs and submits (the wrong Run LeetCode called Accepted too), the wrong submit’s case, a code marker, the outcome and the pulls; again after a reload; an unknown id',
      async run(ctx) {
        await ctx.ui.goto('/recruiting');
        await sittingLink(ctx, 'a').click({ timeout: 15_000 });
        await ctx.page.waitForURL(new RegExp(`/recruiting/sittings/${state.a}$`), {
          timeout: 10_000,
        });
        const check = async () => {
          const timeline = ctx.page.getByRole('list', { name: 'Runs and submits' });
          await timeline.getByText('Wrong Answer · 88/307').waitFor({ timeout: 15_000 });
          await timeline.getByText('Accepted · 307/307').waitFor({ timeout: 5_000 });
          await timeline.getByText('Runtime Error · 0/3').waitFor({ timeout: 5_000 });
          await timeline.getByText('Wrong Answer · 0/2').waitFor({ timeout: 5_000 });
          if (await timeline.getByText('Accepted · 0/2').count())
            throw new Error('the wrong Run reads as Accepted');
          await timeline
            .getByText(/code changed ×\d+/)
            .first()
            .waitFor({ timeout: 5_000 });
          await ctx.page.getByText('accepted on submit 2').waitFor({ timeout: 5_000 });
          await ctx.page.getByText(/Claude watched live · 9 pulls/).waitFor({ timeout: 5_000 });
        };
        await check();
        const wrong = ctx.page.getByRole('listitem').filter({ hasText: 'Wrong Answer · 88/307' });
        await wrong.getByText('Failing case').click();
        await wrong.getByText('[3,3]').waitFor({ timeout: 5_000 });
        await ctx.shot('sitting-detail');
        await ctx.page.reload();
        await check();
        // An unknown id: the real server's answer, replayed to the page once. Asked live first, so its Not found is
        // proven; the page then gets exactly that 400 through an intercept, because a real failed load lands in
        // the console and fails noConsoleErrors (the intercept's window is left out of it, DEV-CHECK.md).
        const unknown = devUlid();
        const said = await ctx.api.reads.getSitting(unknown).then(
          () => 'a sitting',
          (e: unknown) => String((e as Error)?.message ?? e),
        );
        const body = /HTTP 400: (\{.*\})/.exec(said)?.[1];
        if (!body || !/Not found/.test(body))
          throw new Error(`getSitting(unknown) answered ${said}`);
        const notFound = await ctx.intercept('getSitting', {
          status: 400,
          body: JSON.parse(body),
          times: 1,
        });
        await ctx.ui.goto(`/recruiting/sittings/${unknown}`);
        await ctx.page.getByText('No such sitting.').waitFor({ timeout: 15_000 });
        if (notFound.hits() !== 1) throw new Error(`the unknown id read ${notFound.hits()} times`);
        await notFound.release();
        await ctx.page.getByRole('link', { name: 'Back to sittings' }).waitFor({ timeout: 5_000 });
      },
    },
    {
      id: 'ui-review',
      entry: 'ui',
      cost: 'slow',
      proves: ['rev-save', 'rev-fields-16px', 'draft-ui', 'draft-fail'],
      title:
        'Review A on its page: a failed draft, a canned draft ticked and edited, every field saved and read back after a reload',
      async run(ctx) {
        await ctx.ui.goto(`/recruiting/sittings/${state.a}`);
        const form = ctx.page.getByRole('region', { name: 'Review' });
        const hint = form.getByRole('button', { name: 'A hint' });
        await hint.waitFor({ timeout: 15_000 });
        if ((await hint.getAttribute('aria-pressed')) !== 'true')
          throw new Error('help doesn’t start on a hint after a failed submit');
        await form.getByLabel('How it went', { exact: true }).waitFor({ timeout: 5_000 });
        const sizes = await fieldSizes(ctx, 'section[aria-labelledby]');
        if (!sizes.length || sizes.some((px) => px < 16))
          throw new Error(`review field sizes ${JSON.stringify(sizes)} — under 16px zooms iOS`);
        await ctx.shot('review-empty');
        await form.getByLabel('One-liner', { exact: true }).fill('devcheck one-liner');
        await form.getByRole('button', { name: 'Add a mistake' }).click();
        await form.getByLabel('Mistake 1', { exact: true }).fill('devcheck own mistake');
        // A failed draft: said inline, the typed mistake kept.
        const fail = await ctx.intercept('draftSittingReview', { status: 500, times: 1 });
        await form.getByRole('button', { name: 'Draft with Claude' }).click();
        await form.getByText(/Couldn’t draft/).waitFor({ timeout: 10_000 });
        await fail.release();
        if (
          (await form.getByLabel('Mistake 1', { exact: true }).inputValue()) !==
          'devcheck own mistake'
        )
          throw new Error('the failed draft lost the typed mistake');
        // A canned draft: the model can't be told what to say, so the reply is the harness's.
        const canned = await ctx.intercept('draftSittingReview', {
          status: 200,
          times: 1,
          body: { ok: true, mistakes: ['devcheck draft one', 'devcheck draft two'] },
        });
        await form.getByRole('button', { name: 'Draft with Claude' }).click();
        const draft = form.getByRole('group', { name: 'Claude’s draft' });
        await draft.getByLabel('Draft line 2', { exact: true }).waitFor({ timeout: 10_000 });
        await canned.release();
        const boxes = draft.getByRole('checkbox');
        for (let i = 0; i < (await boxes.count()); i++)
          if (await boxes.nth(i).isChecked()) throw new Error('a draft line arrived ticked');
        await ctx.shot('review-draft');
        // Again with the mistake and draft lines open: they are their own (autogrow) fields.
        const grown = await fieldSizes(ctx, 'section[aria-labelledby]');
        if (grown.length <= sizes.length || grown.some((px) => px < 16))
          throw new Error(
            `review field sizes with lines ${JSON.stringify(grown)} — under 16px zooms iOS`,
          );
        await draft.getByLabel('Draft line 2', { exact: true }).fill('devcheck draft two, edited');
        await draft.getByLabel('Keep draft line 2', { exact: true }).click();
        await form.getByLabel('Tags', { exact: true }).fill('Devcheck-Tag');
        await form.getByLabel('Tags', { exact: true }).press('Enter');
        await form.getByLabel('How it went', { exact: true }).fill('devcheck how it went');
        await form.getByRole('button', { name: 'Save review' }).click();
        await form.getByText('Saved.').waitFor({ timeout: 15_000 });
        const r = (await sittingA(ctx)).sitting.review;
        if (
          r?.insight !== 'devcheck one-liner' ||
          r.help !== 'hint' ||
          JSON.stringify(r.mistakes) !==
            JSON.stringify(['devcheck own mistake', 'devcheck draft two, edited']) ||
          JSON.stringify(r.tags) !== JSON.stringify(['devcheck-tag']) ||
          r.howItWent !== 'devcheck how it went' ||
          !r.draftUsed
        )
          throw new Error(`saved review: ${JSON.stringify(r)}`);
        await ctx.page.reload();
        await form.getByLabel('One-liner', { exact: true }).waitFor({ timeout: 15_000 });
        if (
          (await form.getByLabel('One-liner', { exact: true }).inputValue()) !==
          'devcheck one-liner'
        )
          throw new Error('the one-liner didn’t read back');
        if (
          (await form.getByLabel('Mistake 2', { exact: true }).inputValue()) !==
          'devcheck draft two, edited'
        )
          throw new Error('the ticked draft line didn’t read back');
        await form.getByText('devcheck how it went').waitFor({ timeout: 5_000 });
        await ctx.shot('review-saved');
        // Use all ticks every line of a fresh draft (nothing saved after).
        const again = await ctx.intercept('draftSittingReview', {
          status: 200,
          times: 1,
          body: { ok: true, mistakes: ['a', 'b'] },
        });
        await form.getByRole('button', { name: 'Draft with Claude' }).click();
        await draft.getByRole('button', { name: 'Use all' }).click({ timeout: 10_000 });
        await again.release();
        for (let i = 0; i < (await boxes.count()); i++)
          if (!(await boxes.nth(i).isChecked())) throw new Error('Use all left a line unticked');
        await ctx.ui.goto('/recruiting');
        await sittingLink(ctx, 'a')
          .getByRole('img', { name: 'reviewed' })
          .waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'double-start',
      entry: 'api',
      proves: ['double-start', 'prep-target', 'end-drop', 'late-drop'],
      title:
        'Start C twice at once (one sitting, one rep, one plan row); tag it; dropping its rep abandons it, and a note stamped before the drop still lands',
      async run(ctx) {
        const input = start(ctx, 'c');
        const [x, y] = await Promise.all([
          ctx.api.writes.lcSittingStart(input),
          ctx.api.writes.lcSittingStart({ ...input }),
        ]);
        if (x.sitting.id !== y.sitting.id || [x.resumed, y.resumed].filter(Boolean).length !== 1)
          throw new Error(`two answers: ${JSON.stringify([x.resumed, y.resumed])}`);
        const reps = (await ctx.api.reads.listTasks()).filter(
          (t) => t.title === `LeetCode · ${titleOf(ctx, 'c')}`,
        );
        if (reps.length !== 1 || reps[0]!.status !== 'in_progress')
          throw new Error(`reps for C: ${JSON.stringify(reps)}`);
        const plans = await ctx.api.reads.listPlansForDay(x.sitting.day);
        if (plans.filter((p) => p.taskId === reps[0]!.id).length !== 1)
          throw new Error('C’s rep isn’t on its day exactly once');
        const id = x.sitting.id;
        state.c = id;
        const tagged = await ctx.api.writes.setSittingPrepTarget(id, '  devcheck-target ');
        const blank = await ctx.api.writes.setSittingPrepTarget(id, '   ');
        if (tagged.prepTarget !== 'devcheck-target' || blank.prepTarget !== 'General')
          throw new Error('the prep target didn’t normalize');
        const beforeDrop = (state.cBeforeDrop = Date.now());
        await ctx.api.writes.finishTask(reps[0]!.id, 'cancelled');
        const after = (await ctx.api.reads.getSitting(id)).sitting;
        if (after.status !== 'abandoned') throw new Error(`C after Drop: ${after.status}`);
        // A note, so C's timeline stays empty for mcp-read (the timeline is runs, submits and snapshots only).
        const late = await ctx.api.writes.lcSittingEvents(id, [
          { id: devUlid(), type: 'note', at: beforeDrop, payload: { text: 'devcheck late note' } },
        ]);
        if (late.accepted !== 1 || late.skipped !== 0 || late.status !== 'abandoned')
          throw new Error(`a note from before the drop: ${JSON.stringify(late)}`);
        const c1 = (await ctx.api.reads.getSitting(id)).sitting;
        if (c1.summary.notes !== after.summary.notes + 1 || c1.status !== 'abandoned')
          throw new Error(`C after a late note: ${JSON.stringify(c1)}`);
      },
    },
    {
      id: 'mcp-legacy-gone',
      entry: 'mcp',
      proves: ['mcp-legacy-gone'],
      title: 'MCP’s tool list has no list_leetcode_attempts',
      async run(ctx) {
        if ((await ctx.mcp.reads.toolsList()).includes('list_leetcode_attempts'))
          throw new Error('list_leetcode_attempts is still offered');
      },
    },
    {
      id: 'mcp-read',
      entry: 'mcp',
      proves: [
        'get-latest',
        'get-id',
        'get-unknown',
        'list-range',
        'list-empty',
        'list-bad',
        'run-wrong',
        'code-lang',
        'get-statement',
      ],
      title:
        'get_sitting with no id is C; with A’s id, A’s statement and companies, timeline (the wrong Run as one), code in Python3 and review; list_sittings by today, limit, a past month, bad arguments',
      async run(ctx) {
        const r = ctx.mcp.reads;
        // Its own review on A: this step is cheap, so it can't lean on the slow ui-review's.
        await ctx.api.writes.setSittingReview(
          state.a,
          review({ insight: 'devcheck mcp one-liner', tags: ['devcheck-mcp'] }),
        );
        const latest = await r.getSitting();
        if (latest.sitting?.id !== state.c || latest.review !== null || latest.timeline?.length)
          throw new Error(`latest: ${JSON.stringify(latest).slice(0, 400)}`);
        const a = await r.getSitting({ id: state.a });
        const wrong = a.timeline?.find(
          (e) => e.kind === 'judged' && e.type === 'submit' && e.verdict === 'wrong_answer',
        );
        const run = a.timeline?.find(
          (e) => e.kind === 'judged' && e.type === 'run' && e.total === 2,
        );
        if (
          a.sitting?.id !== state.a ||
          wrong?.kind !== 'judged' ||
          wrong.detail.input !== '[3,3]\n6' ||
          wrong.detail.expected !== '[0,1]' ||
          run?.kind !== 'judged' ||
          run.verdict !== 'wrong_answer' ||
          run.statusMsg !== 'Wrong Answer' ||
          run.detail.output !== '[0,0]' ||
          a.problem?.statement !== 'devcheck statement' ||
          JSON.stringify(a.problem.companies) !== JSON.stringify(['Acme']) ||
          !a.code?.final ||
          a.code.lang !== 'Python3' ||
          a.review?.insight !== 'devcheck mcp one-liner'
        )
          throw new Error(
            `get A: ${JSON.stringify({ ...a, code: a.code?.version }).slice(0, 600)}`,
          );
        try {
          await r.getSitting({ id: devUlid() });
          throw new Error('a foreign id was read');
        } catch (err) {
          if (!/Not found/.test(String(err))) throw err;
        }
        const { day } = (await sittingA(ctx)).sitting;
        const listed = await r.listSittings({ from: day, to: day });
        const ids = listed.sittings.map((x) => x.id);
        const ia = ids.indexOf(state.a);
        const ic = ids.indexOf(state.c);
        if (ia < 0 || ic < 0 || ic > ia) throw new Error(`list: ${JSON.stringify(ids)}`);
        const rowA = listed.sittings[ia]!;
        if (!rowA.reviewed || JSON.stringify(rowA.tags) !== JSON.stringify(['devcheck-mcp']))
          throw new Error(`row A: ${JSON.stringify(rowA)}`);
        const one = await r.listSittings({ limit: 1 });
        if (one.sittings.length !== 1 || !one.more)
          throw new Error(`limit 1: ${JSON.stringify(one)}`);
        const past = await r.listSittings({ from: '2020-01-01', to: '2020-01-31' });
        if (past.sittings.length || past.more) throw new Error('a past month isn’t empty');
        const bad: [string, () => Promise<unknown>][] = [
          ['limit "5"', () => r.listSittings({ limit: '5' })],
          ['limit 0', () => r.listSittings({ limit: 0 })],
          ['from alone', () => r.listSittings({ from: day })],
          ['from after to', () => r.listSittings({ from: '2020-01-02', to: '2020-01-01' })],
          ['from "yesterday"', () => r.listSittings({ from: 'yesterday', to: day })],
          ['id "x"', () => r.getSitting({ id: 'x' })],
        ];
        for (const [what, call] of bad) {
          try {
            await call();
            throw new Error(`${what} was taken`);
          } catch (err) {
            if (!(err instanceof McpRpcError) || err.code !== PARAM_ERROR) throw err;
          }
        }
      },
    },
    {
      id: 'late-neighbour',
      entry: 'api',
      cost: 'slow', // it starts D, which only ui-end (slow) uses and ends
      proves: ['late-neighbour'],
      title:
        'Start D; a note stamped before C’s drop, sent now, lands on C and leaves D’s head and live row as they were',
      async run(ctx) {
        if (!state.cBeforeDrop) throw new Error('no drop of C — the double-start step failed');
        const { sitting } = await ctx.api.writes.lcSittingStart(start(ctx, 'd'));
        state.d = sitting.id;
        state.dRep = sitting.repTaskId;
        state.dStartedAt = sitting.startedAt;
        await ctx.api.writes.lcSittingEvents(state.d, [snap('print("d")', Date.now())]);
        await ctx.api.writes.setTaskEstimate(state.dRep, null, null); // the Roll's 45 fills it in hindsight
        const d0 = JSON.stringify(await ctx.api.reads.getSitting(state.d));
        const late = await ctx.api.writes.lcSittingEvents(state.c, [
          {
            id: devUlid(),
            type: 'note',
            at: state.cBeforeDrop,
            payload: { text: 'devcheck late note' },
          },
        ]);
        if (late.accepted !== 1 || late.status !== 'abandoned')
          throw new Error(`a note to C beside open D: ${JSON.stringify(late)}`);
        if (JSON.stringify(await ctx.api.reads.getSitting(state.d)) !== d0)
          throw new Error('a late note to C moved D');
      },
    },
    {
      id: 'ui-end',
      entry: 'ui',
      cost: 'slow',
      proves: [
        'home-prefill',
        'prefill-estimate',
        'home-link',
        'home-neighbour',
        'home-minutes',
        'end-cancel',
        'end-ui',
      ],
      title:
        'D as Home’s hero shows D’s minutes and its Done starts on them, and as a row under a planned neighbour it shows them too; Home links its rep (and only it) to D’s page; End sitting → Cancel keeps it open; End → Mark done ends it',
      async run(ctx) {
        if (!state.d) throw new Error('no sitting D — the late-neighbour step failed');
        const link = ctx.page.getByRole('link', { name: 'End the LeetCode sitting →' });
        const hindsight = async (where: string) => {
          const shown = await ctx.page.getByLabel('Estimate in hindsight').inputValue();
          if (shown !== '45')
            throw new Error(`${where}: estimate in hindsight “${shown}”, not the Roll’s 45`);
        };
        const dMinutes = () => Math.max(1, Math.round((Date.now() - state.dStartedAt) / 60_000));
        // The minutes D's rep shows on Home, as the hero ("Nm of ~45m" / "Nm logged") or a row ("Nm in"): the
        // sitting's, never below 1 — the rep's own reads 0m, as no timer ran.
        const homeMinutes = async (where: string) => {
          const text = link
            .first()
            .locator('xpath=..')
            .getByText(/^\d+m( in| of ~| logged|$)/);
          const shown = Number(
            /^(\d+)m/.exec((await text.first().textContent()) ?? '')?.[1] ?? NaN,
          );
          if (!(shown >= 1) || Math.abs(shown - dMinutes()) > 1)
            throw new Error(
              `Home's ${where} shows ${shown}m for D, the sitting's is ${dMinutes()}m`,
            );
        };
        // D's rep alone in progress, so it is Home's hero: its Done prefills from the sitting.
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Daytime' }).click();
        await link.first().waitFor({ timeout: 15_000 });
        const heroDone = link
          .first()
          .locator('xpath=..')
          .getByRole('button', { name: 'Done', exact: true });
        if ((await heroDone.count()) !== 1)
          throw new Error(
            'D’s rep isn’t Home’s hero — is another task in progress for the test user?',
          );
        await homeMinutes('hero');
        await heroDone.click();
        const heroShown = Number(await ctx.page.getByLabel('Actual (min)').inputValue());
        if (!(heroShown >= 1) || Math.abs(heroShown - dMinutes()) > 1)
          throw new Error(`Home's Done prefilled ${heroShown}, D's ${dMinutes()}`);
        await hindsight('Home');
        await ctx.shot('home-done-prefill');
        await ctx.page.getByRole('button', { name: 'Cancel' }).click();
        if ((await ctx.api.reads.getSitting(state.d)).sitting.status !== 'active')
          throw new Error('Cancel on Home ended D');
        // A planned neighbour in progress takes the hero, so D's rep drops to an Also-today row.
        const other = await ctx.api.writes.createTask({ title: titleOf(ctx, 'neighbour') });
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const { today } = datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
        await ctx.api.writes.upsertPlan({
          taskId: other.id,
          day: today,
          plannedMinutes: 30,
          order: -1,
        });
        await ctx.api.writes.transitionTask(other.id, 'in_progress');
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Daytime' }).click();
        await link.first().waitFor({ timeout: 15_000 });
        if (
          (await link
            .first()
            .locator('xpath=..')
            .getByRole('button', { name: 'Done', exact: true })
            .count()) !== 0
        )
          throw new Error('D’s rep is still Home’s hero after the planned neighbour started');
        await homeMinutes('row');
        const hrefs: (string | null)[] = [];
        for (let i = 0; i < (await link.count()); i++)
          hrefs.push(await link.nth(i).getAttribute('href'));
        if (JSON.stringify(hrefs) !== JSON.stringify([`/recruiting/sittings/${state.d}`]))
          throw new Error(`Home's sitting links: ${JSON.stringify(hrefs)}`);
        await ctx.shot('home-sitting-link');
        await link.click();
        await ctx.page.waitForURL(new RegExp(`/recruiting/sittings/${state.d}$`), {
          timeout: 10_000,
        });
        const end = ctx.page.getByRole('button', { name: 'End sitting' });
        await end.click({ timeout: 15_000 });
        const shown = Number(await ctx.page.getByLabel('Actual (min)').inputValue());
        const want = dMinutes();
        if (Math.abs(shown - want) > 1) throw new Error(`Actual prefilled ${shown}, D's ${want}`);
        await hindsight('End sitting');
        await ctx.shot('end-sitting');
        await ctx.page.getByRole('button', { name: 'Cancel' }).click();
        if ((await ctx.api.reads.getSitting(state.d)).sitting.status !== 'active')
          throw new Error('Cancel ended D');
        await end.click();
        await ctx.page.getByRole('button', { name: 'Mark done' }).click();
        for (let i = 0; (await ctx.api.reads.getSitting(state.d)).sitting.status !== 'done'; i++) {
          if (i >= 40) throw new Error('Mark done never ended D');
          await new Promise((r) => setTimeout(r, 250));
        }
        await end.waitFor({ state: 'hidden', timeout: 15_000 });
        const out = await ctx.mcp.reads.liveSitting();
        if (out.active || out.lastSitting?.id !== state.d || out.lastSitting.status !== 'done')
          throw new Error(`live after End: ${JSON.stringify(out).slice(0, 300)}`);
        await ctx.api.writes.finishTask(other.id, 'cancelled');
      },
    },
    {
      id: 'ui-ended',
      entry: 'ui',
      cost: 'slow',
      proves: ['ui-ended', 'settings-select'],
      title:
        'After a reload, A reads “accepted on submit 2” and C “dropped”; Settings shows the linked roll',
      async run(ctx) {
        await ctx.ui.goto('/recruiting');
        await ctx.page.reload();
        await sittingLink(ctx, 'a').getByText('accepted on submit 2').waitFor({ timeout: 15_000 });
        await sittingLink(ctx, 'c')
          .getByText(/dropped/)
          .waitFor({ timeout: 5_000 });
        if (await ctx.page.getByRole('region', { name: 'Now' }).count())
          throw new Error('an ended sitting is still pinned as open');
        await ctx.shot('sittings-ended');
        await ctx.ui.goto('/settings#leetcode');
        const select = ctx.page.getByLabel('Sittings are reps of');
        await select.waitFor({ timeout: 15_000 });
        // The select reads empty (and disabled) until the Rolls load — wait for it to settle on the link.
        for (let i = 0; ; i++) {
          const shown = await select.inputValue();
          if (shown === state.rollId) break;
          if (i >= 40) throw new Error(`Settings shows “${shown}”, not the linked roll`);
          await new Promise((r) => setTimeout(r, 250));
        }
        await select.scrollIntoViewIfNeeded();
        await ctx.shot('settings-leetcode');
        // Unlink and relink through the select itself, each landing on the server.
        const until = async (want: string | null) => {
          for (let i = 0; (await ctx.api.reads.getSettings()).leetcodeRollId !== want; i++) {
            if (i >= 40) throw new Error(`the select never saved ${want}`);
            await new Promise((r) => setTimeout(r, 250));
          }
        };
        await select.selectOption({ label: 'No Roll' });
        await until(null);
        await ctx.page
          .getByText(/With no Roll, the extension’s Start is refused/)
          .waitFor({ timeout: 5_000 });
        await ctx.shot('settings-leetcode-none');
        await select.selectOption({ label: titleOf(ctx, 'roll') });
        await until(state.rollId);
      },
    },
    {
      id: 'grace-over',
      entry: 'api',
      cost: 'slow',
      proves: ['grace-over'],
      title: 'Ten minutes after Done on A, an event stamped before Done is refused',
      async run(ctx) {
        if (!state.aDoneAt) throw new Error('no Done on A — the end step failed');
        // SITTING_END_GRACE_MS (scripts can't import shared), plus 5 s for request latency: the wait is on this clock alone.
        const wait = state.aDoneAt + 10 * 60_000 + 5_000 - Date.now();
        if (wait > 0) {
          ctx.log(`waiting ${Math.ceil(wait / 1000)} s for A's grace to run out`);
          await new Promise((r) => setTimeout(r, wait));
        }
        const note: DevSittingEvent = {
          id: devUlid(),
          type: 'note',
          at: state.aBeforeDone,
          payload: { text: 'devcheck past the grace' },
        };
        await refused(
          'events past the grace',
          ctx.api.writes.lcSittingEvents(state.a, [note]),
          /ended/,
        );
      },
    },
    {
      id: 'deletes',
      entry: 'api',
      proves: ['delete-sitting', 'delete-cascade'],
      title:
        'Delete C’s sitting (its rep stays); delete A’s rep (its sitting, with its submits, goes with it)',
      async run(ctx) {
        const c = (await ctx.api.reads.getSitting(state.c)).sitting;
        await ctx.api.writes.deleteSitting(state.c);
        if ((await ctx.api.reads.listSittings()).some((s) => s.id === state.c))
          throw new Error('the deleted sitting is still listed');
        await refused('read after delete', ctx.api.reads.getSitting(state.c), /Not found/);
        if (!(await ctx.api.reads.getTask(c.repTaskId)))
          throw new Error('deleting the sitting took its rep');
        await ctx.api.writes.deleteTask(state.aRep);
        if ((await ctx.api.reads.listSittings()).some((s) => s.id === state.a))
          throw new Error('deleting A’s rep left its sitting');
      },
    },
    {
      id: 'parallel',
      entry: 'api',
      proves: ['parallel-starts'],
      title:
        'Start E and F at once: one opens, the other is refused as still open; drop the winner',
      async run(ctx) {
        const results = await Promise.allSettled([
          ctx.api.writes.lcSittingStart(start(ctx, 'e')),
          ctx.api.writes.lcSittingStart(start(ctx, 'f')),
        ]);
        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        if (won.length !== 1 || lost.length !== 1)
          throw new Error(`${won.length} opened, ${lost.length} refused`);
        const why = String((lost[0] as PromiseRejectedResult).reason);
        if (!/HTTP 400/.test(why) || !/still open/.test(why))
          throw new Error(`refused oddly: ${why}`);
        const { sitting } = (won[0] as PromiseFulfilledResult<{ sitting: { repTaskId: string } }>)
          .value;
        await ctx.api.writes.finishTask(sitting.repTaskId, 'cancelled');
      },
    },
    {
      id: 'archived',
      entry: 'api',
      proves: ['start-archived'],
      title:
        'Archive the linked roll: Start reads it as unlinked; then unlink for the scenarios after',
      async run(ctx) {
        await ctx.api.writes.setRollActive(state.rollId, false);
        await refused(
          'start on an archived roll',
          ctx.api.writes.lcSittingStart(start(ctx, 'd')),
          /LeetCode roll/,
        );
        await ctx.api.writes.linkLeetcodeRoll(null);
      },
    },
    // PR D. The probe posts no input, so even a server that still had the method could not write a row.
    {
      id: 'legacy-refused',
      entry: 'api',
      proves: ['legacy-refused'],
      title: 'recordLeetcodeAttempt, twice: the JWT gets no API answer, a non-JWT bearer 401s',
      async run(ctx) {
        for (const round of [1, 2]) {
          const device = await ctx.api.reads.legacyWriteProbe('bogus-device');
          if (device.status !== 401)
            throw new Error(
              `round ${round}: device bearer → ${device.status} ${device.text.slice(0, 120)}`,
            );
          // CloudFront (and the local edge, lambdas/src/local/edge.ts) serves an origin 404 as index.html, a 200.
          const jwt = await ctx.api.reads.legacyWriteProbe('jwt');
          if (jwt.status !== 200 || !/^\s*<!doctype html/i.test(jwt.text))
            throw new Error(
              `round ${round}: JWT → ${jwt.status} ${jwt.text.slice(0, 120)} — the method still answers`,
            );
        }
      },
    },
    noConsoleErrors,
  ],
};
