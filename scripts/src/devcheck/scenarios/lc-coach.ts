// The LeetCode coach on dev (docs/areas/recruiting/coach.md): today's plan through the API and leetcode_today,
// a sitting on a slot moving it in progress then done, an off-plan sitting leaving the queue alone, the review
// merge, the four MCP writes as the test user, the floor and focus, and the schedule over backdated attempts; then
// the app (PR A-app): the Today card, the review's cause and Peeked, F169, Home's morning line; then PR B's history,
// stats, story and focus tools, delete_attempt, and the review draft's cause (one real Haiku call, slow tier).
// Everything this run makes is ledgered by id and cleaned by the pipeline: sittings (with their reps), rolls and the
// roll link, attempts (deleteCoachAttempt), slot changes (restored), the floor (off), the focus (cleared), a story and
// mocks (deleteMock; the app's are recorded from its upsertMock response).
// Problem slugs outside the catalog are synthetic; a sitting on a slot uses the slot's own (public) catalog slug. The
// schedule step's backdated attempts change the plan for any read after it, so the app steps after it read the plan
// live, never an earlier step's; PR B's reads run over what it logged. PR D's Patterns tab (its ranking, failed reads,
// a refused write, Set as focus and back, 390 px) runs just before the schedule step. PR E's mocks (the card's form,
// a planned one in the next 48 hours, the Patterns list, log_mock and list_mocks) run last.
import { PHONE } from '../browser';
import { McpRpcError, PARAM_ERROR } from '../mcp';
import type {
  DevCoachSlot,
  DevCoachStats,
  DevCoachToday,
  DevMock,
  DevSittingEvent,
  DevSittingStart,
} from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { devUlid } from './flux-history';

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const tag = (ctx: Ctx) => ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const slugOf = (ctx: Ctx, which: string) => `devcheck-coach-${tag(ctx)}-${which}`;
const titleOf = (ctx: Ctx, which: string) => `devcheck-coach ${ctx.nonce} ${which}`;
const start = (slug: string, title: string): DevSittingStart => ({
  clientSittingId: devUlid(),
  problemSlug: slug,
  problemTitle: title,
  difficulty: 'Easy',
  topicTags: ['Array'],
  lang: 'python3',
  startedAt: Date.now(),
  tzOffsetMinutes: 480, // the test user's day is LA's
});
const accepted = (at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'submit',
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result: { status_code: 10, status_msg: 'Accepted', total_correct: 3, total_testcases: 3 },
  },
});
const wrong = (at: number): DevSittingEvent => ({
  id: devUlid(),
  type: 'submit',
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("devcheck")' },
    result: { status_code: 11, status_msg: 'Wrong Answer', total_correct: 1, total_testcases: 3 },
  },
});
const fail = (msg: string): never => {
  throw new Error(msg);
};
const expectParamError = async (what: string, call: () => Promise<unknown>) => {
  try {
    await call();
  } catch (err) {
    if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
    throw err;
  }
  fail(`${what}: expected a param error (-32602), got a result`);
};
const slugs = (t: DevCoachToday) => t.slots.map((s) => s.slug);
// The Patterns tab's rows: NeetCode's 18 (scripts doesn't depend on shared; neetcode150.test.ts pins the count).
const PATTERN_COUNT = 18;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
// The Progress step's history-only pick: Hard list problems no other step touches, the first with no record here
// (public list facts: slug, title, pattern). PR F.
const PROGRESS_PICKS = [
  { slug: 'burst-balloons', title: 'Burst Balloons', pattern: 'dp-2d', patternName: '2-D DP' },
  {
    slug: 'regular-expression-matching',
    title: 'Regular Expression Matching',
    pattern: 'dp-2d',
    patternName: '2-D DP',
  },
  {
    slug: 'swim-in-rising-water',
    title: 'Swim in Rising Water',
    pattern: 'advanced-graphs',
    patternName: 'Advanced Graphs',
  },
];
// NeetCode 150's LeetCode Premium problems (public list facts; neetcode150.ts marks them `premium`).
const PREMIUM_SLUGS = [
  'encode-and-decode-strings',
  'walls-and-gates',
  'number-of-connected-components-in-an-undirected-graph',
  'graph-valid-tree',
  'alien-dictionary',
  'meeting-rooms',
  'meeting-rooms-ii',
];
const DESKTOP = { width: 1512, height: 860 }; // the 14" MacBook Pro's Safari content area
// What the progress steps share: the pick, its history-only attempt id, and the plan and stats before it.
const progress = {
  pick: null as (typeof PROGRESS_PICKS)[number] | null,
  id: '',
  note: '',
  planBefore: null as DevCoachToday | null,
  statsBefore: null as DevCoachStats | null,
};
const progressState = () => ({
  pick: progress.pick ?? fail('no history-only pick — the progress-mcp step failed'),
  id: progress.id,
  note: progress.note,
  planBefore: progress.planBefore ?? fail('no plan read before the history-only solve'),
  statsBefore: progress.statsBefore ?? fail('no stats read before the history-only solve'),
});

// What this run made and read, shared across steps (a scenario's steps run in order).
const state = {
  plan: null as DevCoachToday | null,
  slotSlug: '',
  slotKind: '',
  sittingId: '',
  repId: '',
  offId: '',
  offRep: '',
  offBefore: null as DevCoachToday | null,
};
const plan = () => state.plan ?? fail('no plan read — the plan step failed');
const today = () => plan().day;

// A sitting through to Done: an accepted submit (unless `accept` is false), the actual, Done on its rep.
async function finish(ctx: Ctx, sittingId: string, repId: string, accept = true) {
  if (accept) await ctx.api.writes.lcSittingEvents(sittingId, [accepted(Date.now())]);
  await ctx.api.writes.setTaskActual(repId, accept ? 15 : 1);
  await ctx.api.writes.finishTask(repId, 'done');
}
const due = (x: DevCoachToday) => x.due.map((q) => `${q.slug}@${q.dueDay}`);
const why = {
  history:
    'whether the dev test user has coach history depends on what earlier runs and other scenarios left; a run can’t make the account empty',
};

export const lcCoach: Scenario = {
  id: 'lc-coach',
  title: 'The LeetCode coach: today’s plan, slots by sitting, and the MCP tools',
  tiers: ['full'],
  // The draft's cause (a real Haiku call) runs when a branch touches the draft or this scenario.
  slowPaths: [
    'lambdas/src/anthropic/sittingReviewPrompt.ts',
    'packages/shared/src/sittings.ts',
    'scripts/src/devcheck/scenarios/lc-coach.ts',
  ],
  rows: [
    {
      id: 'plan',
      entry: 'api',
      kind: 'nominal',
      what: 'getCoachToday answers today’s plan: 1–4 slots, each with a kind, a reason and the 30-minute cap, and a floor',
    },
    {
      id: 'today-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: '"what’s today?" — tools/list has the coach’s five tools; leetcode_today answers the same slots with their coaching rules',
    },
    {
      id: 'slot-in-progress',
      entry: 'api',
      kind: 'nominal',
      what: 'A Start on a slot’s problem marks that slot in progress, with its sitting',
    },
    {
      id: 'live-slot',
      entry: 'mcp',
      kind: 'nominal',
      what: 'live_sitting on that sitting names its slot kind, the cap and the rules for it, and no trace yet',
    },
    {
      id: 'slot-done',
      entry: 'api',
      kind: 'nominal',
      what: 'Done on its rep marks the slot done with its outcome; the plan’s problems don’t move',
    },
    {
      id: 'review-merge',
      entry: 'api',
      kind: 'edge',
      what: 'A cause set by patchSittingReview survives a review save that doesn’t send it',
    },
    {
      id: 'mcp-peek-sitting',
      entry: 'mcp',
      kind: 'nominal',
      what: '"I looked at the solution" mid-sitting — mark_peeked on the open sitting records it and says the re-solve is due tomorrow; a form save after it without help keeps the peek',
    },
    {
      id: 'mcp-cause',
      entry: 'mcp',
      kind: 'nominal',
      what: '"it was a boundary case" — set_cause_tag saves the one cause on the sitting’s review',
    },
    {
      id: 'off-plan',
      entry: 'api',
      kind: 'edge',
      what: 'A sitting on a problem off the plan lands in offPlan; the slots and the due list are unchanged',
    },
    {
      id: 'mcp-peeked',
      entry: 'mcp',
      kind: 'nominal',
      what: 'mark_peeked on a problem with no sitting puts it on the peeked track, due tomorrow; a repeat is one state',
    },
    {
      id: 'mcp-swap',
      entry: 'mcp',
      kind: 'nominal',
      what: '"too hard, an easier one" — swap_slot swaps a slot to an easier problem; restore brings the original back',
    },
    {
      id: 'mcp-skip',
      entry: 'mcp',
      kind: 'nominal',
      what: '"skip it today" — swap_slot skip marks the slot skipped; restore opens it again',
    },
    {
      id: 'mcp-log',
      entry: 'mcp',
      kind: 'nominal',
      what: '"I did one on paper, clean" — log_attempt counts toward momentum and schedules the re-solve in 3 days',
    },
    {
      id: 'floor-focus',
      entry: 'api',
      kind: 'nominal',
      what: 'The floor turns on and off; a focus override holds from today on its pattern, and clearing it hands back to the engine',
    },
    {
      id: 'mcp-bad-args',
      entry: 'mcp',
      kind: 'edge',
      what: 'Bad arguments are param errors and an unknown slot is refused, with nothing written',
    },
    {
      id: 'ownership',
      entry: 'mcp',
      kind: 'edge',
      what: 'A peek or a cause aimed at a sitting that isn’t the user’s is refused, nothing written',
    },
    {
      id: 'test-sitting',
      entry: 'api',
      kind: 'edge',
      what: 'A test sitting — under 3 minutes with no accept, or flagged — never becomes a problem record',
    },
    {
      id: 'scheduler',
      entry: 'mcp',
      kind: 'edge',
      what: 'Backdated attempts schedule by the table: clean steps on, solved repeats the gap, failed restarts the peeked track, past the last step graduates',
    },
    {
      id: 'empty-account',
      entry: 'api',
      kind: 'edge',
      what: 'An account with no history gets new problems and a stretch, no carry-over; the floor is the new pick',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'empty account: new problems in the first pattern, a stretch, no carry-over; floor = the new pick',
        why: why.history,
      },
    },
    {
      id: 'stretch-two',
      entry: 'api',
      kind: 'edge',
      what: 'With no re-solve due, the stretch takes a second slot; never more than 4',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'an empty re-solve queue lets the stretch take two; never more than 4, never padded',
        why: why.history,
      },
    },
    {
      id: 'day-boundary',
      entry: 'mcp',
      kind: 'edge',
      what: 'The plan’s day turns at dayStartHour in the user’s zone',
      offDev: {
        file: 'lambdas/src/mcp/coachTools.test.ts',
        test: 'turns its day at dayStartHour in the user’s zone',
        why: 'dev’s clock can’t be moved to the boundary',
      },
    },
    {
      id: 'claude-asks',
      entry: 'mcp',
      kind: 'nominal',
      what: 'In a real claude.ai thread, Claude says what it will write and waits for a yes before each coach write',
      needsYou:
        'the claude.ai connector and the model’s behaviour are the user’s to watch (the dev thread walk)',
    },
    // --- The app (PR A-app): the Today card, the review's cause and Peeked, Home's morning line ---
    {
      id: 'ui-card',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Today card on /recruiting shows each slot with its kind, the 30-minute cap, its reason and a LeetCode link, plus the focus and momentum',
    },
    {
      id: 'ui-swap',
      entry: 'ui',
      kind: 'nominal',
      what: 'Another swaps a slot to an easier problem (Skip when nothing easier is left); Restore brings the original back',
    },
    {
      id: 'ui-slot-focus',
      entry: 'ui',
      kind: 'edge',
      what: 'Restore, then Another or Skip, keep keyboard focus in the slot’s row as its buttons change',
    },
    {
      id: 'ui-slot-focus-midwrite',
      entry: 'ui',
      kind: 'edge',
      what: 'A slot whose row a read changes while its write runs still gets its focus move when the write lands',
      offDev: {
        file: 'app/src/pages/Recruiting/TodayCard.test.tsx',
        test: 'a Skip whose row a read changed mid-write still lands focus on Restore',
        why: 'dev can’t hold a slot write open while another write’s read lands on the same row',
      },
    },
    {
      id: 'ui-slot-no-late-focus',
      entry: 'ui',
      kind: 'edge',
      what: 'A slot change that left its row as it was never moves focus later, when a read changes the row',
      offDev: {
        file: 'app/src/pages/Recruiting/TodayCard.test.tsx',
        test: 'a slot change that lands without changing its row arms nothing: a later read doesn’t pull focus into the row',
        why: 'its answer must equal the plan on screen, which only a read that raced the write leaves; dev can’t order the two',
      },
    },
    {
      id: 'ui-slot-stale-read',
      entry: 'ui',
      kind: 'edge',
      what: 'A read that began before a slot change can’t put the old plan back on the card',
      offDev: {
        file: 'app/src/pages/Recruiting/TodayCard.test.tsx',
        test: 'a read that began before a slot change can’t put the old plan back',
        why: 'an intercept fulfils or forwards at once; dev can’t hold a read open across a write',
      },
    },
    {
      id: 'ui-cause',
      entry: 'ui',
      kind: 'nominal',
      what: 'A cause chip and Peeked, saved in the review form, read back after a reload',
    },
    {
      id: 'review-cause-head',
      entry: 'api',
      kind: 'nominal',
      what: 'The form’s Save puts the cause and help: solution on the sitting’s head',
    },
    {
      id: 'ui-f169',
      entry: 'ui',
      kind: 'edge',
      what: 'A Save in a review form opened before Claude’s mark_peeked keeps the peek (F169)',
    },
    {
      id: 'ui-suggested',
      entry: 'ui',
      kind: 'nominal',
      what: 'A first submit that failed with no Run opens the form on a suggested No trace; an untouched Save stores it, and clearing the chip stores none',
    },
    {
      id: 'ui-unreviewed',
      entry: 'ui',
      kind: 'nominal',
      what: 'An ended sitting with no cause yet is listed on the card, linking to its review',
    },
    {
      id: 'ui-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed read of today’s plan says so on the card with Retry, and Retry recovers',
    },
    {
      id: 'ui-home',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s morning line reads the day’s plan and links to the card',
    },
    {
      id: 'ui-home-absent',
      entry: 'ui',
      kind: 'edge',
      what: 'With no LeetCode roll linked, Home’s morning has no LeetCode line',
    },
    {
      id: 'ui-empty',
      entry: 'ui',
      kind: 'edge',
      what: 'An empty account’s card offers new problems only — no carry-over, no re-solves',
      offDev: {
        file: 'app/src/pages/Recruiting/TodayCard.test.tsx',
        test: 'an empty account gets new problems only — no carry-over, no re-solves',
        why: why.history,
      },
    },
    {
      id: 'ui-home-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed read on Home is one visible line linking to the card, never silence',
    },
    {
      id: 'ui-floor',
      entry: 'ui',
      kind: 'nominal',
      what: 'Full day and Floor day on the card turn the floor off and on',
    },
    {
      id: 'ui-focus',
      entry: 'ui',
      kind: 'nominal',
      what: 'Change on the focus line: the coach’s pick clears an override, a pattern sets one, Cancel closes it',
    },
    // --- PR B: the history, stats, story and focus tools, delete_attempt, the draft's cause ---
    {
      id: 'mcp-tools-b',
      entry: 'mcp',
      kind: 'nominal',
      what: 'tools/list has the history, stats and story reads and the two newer writes (set_focus_pattern, delete_attempt)',
    },
    {
      id: 'mcp-due',
      entry: 'mcp',
      kind: 'nominal',
      what: '"what’s due?" — list_problems with due: true is the re-solve queue, oldest due first; a graduated problem isn’t in it',
    },
    {
      id: 'mcp-problem',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_problem reads one problem back: each day tried with its logged-attempt ids, and its re-solve state',
    },
    {
      id: 'mcp-stats',
      entry: 'mcp',
      kind: 'nominal',
      what: '"how am I doing?" — coach_stats counts first tries and re-solves per ISO week and per pattern; a range narrows it',
    },
    {
      id: 'mcp-stories',
      entry: 'mcp',
      kind: 'nominal',
      what: 'list_stories answers the story bank (a list, or empty with a note)',
    },
    {
      id: 'mcp-focus',
      entry: 'mcp',
      kind: 'nominal',
      what: '"let’s do graphs" — set_focus_pattern holds it from today, day 1 of 3, and leetcode_today agrees; null hands back to the engine',
    },
    {
      id: 'mcp-delete',
      entry: 'mcp',
      kind: 'nominal',
      what: '"undo that log" — delete_attempt removes a logged attempt and its problem leaves the list; a repeat writes nothing',
    },
    {
      id: 'mcp-b-bad-args',
      entry: 'mcp',
      kind: 'edge',
      what: 'An unknown pattern or a bad id is a param error; an unknown problem is an error; an id nobody logged deletes nothing',
    },
    {
      id: 'draft-cause',
      entry: 'api',
      kind: 'nominal',
      what: 'The review draft (one Haiku call) answers a cause beside its lines — a tag or null — and writes nothing',
    },
    {
      id: 'ui-draft-cause',
      entry: 'ui',
      kind: 'nominal',
      what: 'The draft’s cause marks its chip (“Claude suggests …”) and never picks it: a Save keeps the old cause; a tap picks it and the Save stores it',
    },
    {
      id: 'mcp-b-empty',
      entry: 'mcp',
      kind: 'edge',
      what: 'With nothing tried, list_problems is an empty list with a note',
      offDev: {
        file: 'lambdas/src/mcp/coachTools.test.ts',
        test: 'is an empty list with a note',
        why: why.history,
      },
    },
    {
      id: 'patterns-table',
      entry: 'ui',
      kind: 'nominal',
      what: 'Recruiting › Patterns lists every pattern weakest first, the focus row marked; a practised pattern shows its server-counted first tries',
    },
    {
      id: 'patterns-set-focus',
      entry: 'ui',
      kind: 'nominal',
      what: '“Set as focus” on a pattern → the day’s plan holds it, day 1 of 3; “Back to the coach’s pick” hands back to the engine',
    },
    {
      id: 'patterns-390',
      entry: 'ui',
      kind: 'edge',
      what: 'At 390 px every row’s “Set as focus” sits on screen, no sideways scroll, light and dark',
    },
    {
      id: 'patterns-load-error',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed stats read shows the error with Retry, never an empty ranking; Retry recovers',
    },
    {
      id: 'patterns-focus-load-error',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed focus read says so above the ranking, Set as focus waits, and Retry recovers',
    },
    {
      id: 'patterns-empty',
      entry: 'ui',
      kind: 'edge',
      what: 'An account with no practice says nothing is ranked yet and lists every pattern not started',
      offDev: {
        file: 'app/src/pages/Recruiting/PatternsSection.test.tsx',
        test: 'an empty account: says nothing is ranked yet, lists every pattern not started, focus line shown',
        why: why.history,
      },
    },
    {
      id: 'patterns-small-counts',
      entry: 'ui',
      kind: 'edge',
      what: 'A practised pattern under 5 tries reads its count only (“First try 0 of 1”), no percentage',
    },
    {
      id: 'patterns-pct',
      entry: 'ui',
      kind: 'edge',
      what: 'From 5 tries a percentage joins the count (“3 of 5 (60%)”)',
      offDev: {
        file: 'app/src/pages/Recruiting/PatternsSection.test.tsx',
        test: 'a pattern with 2 tries shows counts and no percentage; 5 or more adds one',
        why: 'same path as patterns-table (proven on dev): the format is fmtRate’s pure branch on the same render and BFF read; the test user never reaches 5 first tries in one pattern',
      },
    },
    {
      id: 'patterns-focus-refused',
      entry: 'ui',
      kind: 'edge',
      what: 'A refused focus write (the server’s 400 and its reason) says why inline and changes nothing',
    },
    {
      id: 'patterns-stats-detail',
      entry: 'api',
      kind: 'edge',
      what: 'Stats carry submits a try, run-before-submit and trace rate over the attempts with that data',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'submits a try, run-before-submit and trace rate over the attempts with the data',
        why: 'the per-pattern counts on dev mix earlier runs’ history; the contract test (contractTests.ts) runs the same fold on the stub and the backend',
      },
    },
    {
      id: 'patterns-sittings-unchanged',
      entry: 'ui',
      kind: 'edge',
      what: 'The Sittings tab beside it still opens as itself, without the Patterns list',
    },
    {
      id: 'patterns-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'coach_stats carries each pattern’s submits a try, run-first and traced rates, and its weekly first tries',
    },
    // PR F: the Progress tab, history-only solves, LeetCode Premium.
    {
      id: 'progress-map',
      entry: 'ui',
      kind: 'nominal',
      what: 'Recruiting › Progress draws five stages and 18 pattern cards; the summary’s not-tried count is 150 less the list problems the server has records on',
    },
    {
      id: 'progress-open',
      entry: 'ui',
      kind: 'nominal',
      what: 'A card opens its problems (status, re-solve, LeetCode link) in a panel; the open card survives a reload; Close hands keyboard focus back to the card',
    },
    {
      id: 'progress-left',
      entry: 'ui',
      kind: 'nominal',
      what: 'Left only lists just the open pattern’s untried problems',
    },
    {
      id: 'progress-history',
      entry: 'mcp',
      kind: 'nominal',
      what: 'log_attempt historical: true, 400 days back: stored as history with no next due; get_problem shows the try as historical',
    },
    {
      id: 'progress-history-neighbours',
      entry: 'api',
      kind: 'edge',
      what: 'A history-only solve leaves today’s due list, the next 48 h, momentum and the stats counts as they were, and its problem is no slot',
    },
    {
      id: 'progress-history-bad',
      entry: 'mcp',
      kind: 'edge',
      what: 'historical "yes", a historical day 11 years back or today, and a live day 61 days back are refused with a reason; nothing written',
    },
    {
      id: 'progress-history-delete',
      entry: 'mcp',
      kind: 'edge',
      what: 'delete_attempt on the history-only id removes it; the problem has no record again',
    },
    {
      id: 'progress-schema',
      entry: 'mcp',
      kind: 'nominal',
      what: 'tools/list shows `historical` on log_attempt',
    },
    {
      id: 'progress-off-list',
      entry: 'ui',
      kind: 'edge',
      what: 'A problem off the list (this run’s synthetic slug) shows under Off the list, never in the 150',
    },
    {
      id: 'progress-solves',
      entry: 'ui',
      kind: 'nominal',
      what: 'Solves lists every touched problem newest first; a status filter narrows it and survives a reload; no match offers Clear filters, which clears the URL',
    },
    {
      id: 'progress-problem',
      entry: 'ui',
      kind: 'nominal',
      what: 'A Solves row opens the problem’s page: each try with its minutes and logged note, the history-only one marked; ← Progress keeps the filters',
    },
    {
      id: 'progress-trends',
      entry: 'ui',
      kind: 'nominal',
      what: 'Trends draws its four cards over the server’s records',
    },
    {
      id: 'progress-desktop',
      entry: 'ui',
      kind: 'edge',
      what: 'At 1512 and 1024 px the wider tab (map with a card open, Solves, Trends) never scrolls sideways',
    },
    {
      id: 'progress-390',
      entry: 'ui',
      kind: 'edge',
      what: 'At 390 px the map (a card open), Solves and Trends never scroll sideways, light and dark',
    },
    {
      id: 'progress-load-error',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed records read shows the error with Retry, never an empty map; Retry recovers',
    },
    {
      id: 'premium-toggle',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › LeetCode “I have LeetCode Premium” saves off and on, each surviving a reload',
    },
    {
      id: 'premium-off',
      entry: 'ui',
      kind: 'nominal',
      what: 'With Premium switched off in Settings, no unseen pick in today’s plan is a Premium problem: no new or stretch slot, no alternative',
    },
    {
      id: 'premium-picks',
      entry: 'api',
      kind: 'nominal',
      what: 'With Premium on, the plan picks a Premium problem in its turn',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'on: a Premium problem is picked in its turn',
        why: 'which problem comes next depends on the dev account’s history; the plan is a pure fold, run the same by the stub and the Lambda (the lc coach contract test)',
      },
    },
    {
      id: 'progress-focus-load-error',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed focus read: the map still draws, with one line saying no pattern is marked',
      offDev: {
        file: 'app/src/pages/Recruiting/ProgressSection.test.tsx',
        test: 'a failed focus read: the map still draws, with a line saying no pattern is marked',
        why: 'same path as progress-load-error (proven on dev): a failed read of the day’s plan beside a good records read',
      },
    },
    {
      id: 'progress-empty',
      entry: 'ui',
      kind: 'edge',
      what: 'An account with no practice: the whole list not tried, every pattern a card',
      offDev: {
        file: 'app/src/pages/Recruiting/ProgressSection.test.tsx',
        test: 'an empty account: the whole list untried, five stages, every pattern a card',
        why: why.history,
      },
    },
    {
      id: 'progress-sparse',
      entry: 'ui',
      kind: 'edge',
      what: 'Trends with under two active weeks, no re-solve or no timed try says so in each card',
      offDev: {
        file: 'app/src/pages/Recruiting/ProgressSection.test.tsx',
        test: 'Trends: sparse lines with no data; charts with some',
        why: why.history,
      },
    },
    {
      id: 'progress-max',
      entry: 'ui',
      kind: 'edge',
      what: 'Every list problem done: 150 done, none left',
      offDev: {
        file: 'packages/shared/src/coachProgress.test.ts',
        test: 'a full list: everything done',
        why: 'a 150-problem seed on the dev account is all cleanup risk; the fold is pure and the map renders what it returns (progress-map, proven on dev)',
      },
    },
    {
      id: 'progress-long-history',
      entry: 'ui',
      kind: 'edge',
      what: 'A problem with 40 tries lists all 40 on its page',
      offDev: {
        file: 'app/src/pages/Recruiting/ProblemPage.test.tsx',
        test: 'a long history lists every try',
        why: 'same path as progress-problem (proven on dev): one records read, a longer list',
      },
    },
    {
      id: 'progress-unknown',
      entry: 'ui',
      kind: 'edge',
      what: 'An untried list problem reads Not tried yet; a slug on no list and never tried says No problem by that name',
      offDev: {
        file: 'app/src/pages/Recruiting/ProblemPage.test.tsx',
        test: 'an untried list problem reads Not tried yet; an unknown slug says so',
        why: 'same path as progress-problem (proven on dev): one records read, a different slug',
      },
    },
    {
      id: 'progress-mixed',
      entry: 'mcp',
      kind: 'edge',
      what: 'A history-only solve on a problem with a live try (this run’s logged one): get_problem lists the history try first, flagged, and the live schedule stays as it was',
    },
    {
      id: 'progress-swap-seen',
      entry: 'api',
      kind: 'edge',
      what: 'A swap counts a history-only problem as seen and known',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'count as seen and known for a swap',
        why: 'mcp-swap runs setCoachSlot on dev; history and Premium only change the sets slotChangeInputs builds, a pure helper the stub and the Lambda share',
      },
    },
    {
      id: 'progress-swap-premium',
      entry: 'api',
      kind: 'edge',
      what: 'With Premium on, a swap’s default target (the next easier unseen problem) may be a Premium one',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'on: a swap’s default target may be a Premium problem; off, there is none',
        why: 'mcp-swap runs setCoachSlot on dev; the default target is the pure applySlotChange with the Premium flag, shared by the stub and the Lambda',
      },
    },
    {
      id: 'progress-focus-room',
      entry: 'api',
      kind: 'edge',
      what: 'With Premium on, setting the focus counts Premium problems as room',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'on: easier picks and the room check count Premium problems',
        why: 'floor-focus and patterns-set-focus run setCoachFocus on dev; the room check is the pure focusRoomError over the same input',
      },
    },
    // PR E: mock interviews (coach.md → Mocks).
    {
      id: 'mock-ui-log',
      entry: 'ui',
      kind: 'nominal',
      what: 'Log a done mock with Code and Solve on the Today card: it’s stored, and the card’s line shows its scores',
    },
    {
      id: 'mock-ui-invalid',
      entry: 'ui',
      kind: 'edge',
      what: 'Save with no Code score says why inline, keeps what was typed, and writes nothing',
    },
    {
      id: 'mock-ui-plan',
      entry: 'ui',
      kind: 'nominal',
      what: 'Plan a mock for tomorrow: it shows in the card’s next 48 hours; Cancel there removes it',
    },
    {
      id: 'mock-slots-unchanged',
      entry: 'ui',
      kind: 'edge',
      what: 'A mock is not a slot: logging and planning one on the card leave the day’s slots as they were',
    },
    {
      id: 'mock-patterns',
      entry: 'ui',
      kind: 'nominal',
      what: 'Recruiting › Patterns lists the done mock with its Code and Solve beside its week’s first tries',
    },
    {
      id: 'mock-390',
      entry: 'ui',
      kind: 'edge',
      what: 'At 390 px, light and dark, the mock form’s score buttons sit on screen and the page never scrolls sideways',
    },
    {
      id: 'mock-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'log_mock stores a done mock and reads back the week’s line; list_mocks lists it with its scores and trend',
    },
    {
      id: 'mock-mcp-invalid',
      entry: 'mcp',
      kind: 'edge',
      what: 'log_mock with a score out of 1–4, or no Code, is refused with why and writes nothing',
    },
    {
      id: 'mock-ui-log-planned',
      entry: 'ui',
      kind: 'nominal',
      what: 'Log it on a mock planned for today scores that same row done (an edit by id, no second mock)',
    },
    {
      id: 'mock-patterns-delete',
      entry: 'ui',
      kind: 'edge',
      what: 'Delete on the Patterns list asks once inline; Yes removes the mock',
    },
    {
      id: 'mock-ui-unlogged',
      entry: 'ui',
      kind: 'edge',
      what: 'A planned mock whose day passed waits under the card’s line with Log it and Cancel; Cancel removes it',
    },
    {
      id: 'mock-ui-cancel-focus',
      entry: 'ui',
      kind: 'edge',
      what: 'Cancel on a planned mock’s row hands keyboard focus to Log a mock, never <body>',
    },
    {
      id: 'mock-ui-cancel-5xx',
      entry: 'ui',
      kind: 'edge',
      what: 'A Cancel that lands but answers 500 reads as cancelled: the row goes, no error, focus on Log a mock, “Mock cancelled.” said',
    },
    {
      id: 'mock-ui-cancel-save-race',
      entry: 'ui',
      kind: 'edge',
      what: 'A save and a cancel settling on one failed read still hand focus to Log a mock',
      offDev: {
        file: 'app/src/pages/Recruiting/TodayCard.test.tsx',
        test: 'a save and a cancel settling on one failed read: the form’s close still lands focus on Log a mock',
        why: 'dev can’t make the two writes’ reads collapse into one and fail it',
      },
    },
    {
      id: 'mock-delete-idempotent',
      entry: 'api',
      kind: 'edge',
      what: 'deleteMock twice on the same mock: the second is a no-op, and it stays gone',
    },
    {
      id: 'mock-ownership',
      entry: 'api',
      kind: 'edge',
      what: 'Another user’s mock is Not found to change or delete and stays as it was; their sitting can’t be named',
      offDev: {
        file: 'lambdas/src/backend.mocks.test.ts',
        test: 'another user’s mock is Not found to read, change or delete, and stays as it was',
        why: 'dev has one test user, so a second user’s rows can’t exist there (the partition key is the user)',
      },
    },
    {
      id: 'progress-focus-room-history',
      entry: 'api',
      kind: 'edge',
      what: 'Setting the focus counts history-only problems as seen: a pattern with nothing else unseen is refused',
      offDev: {
        file: 'packages/shared/src/coach.test.ts',
        test: 'mark a problem seen for the focus ranking without counting as a first try',
        why: 'floor-focus and patterns-set-focus run setCoachFocus on dev; the room check is the pure focusRoomError over the same input',
      },
    },
  ],
  steps: [
    {
      id: 'plan',
      title: 'Read today’s plan through the API',
      entry: 'api',
      proves: ['plan'],
      async run(ctx) {
        const t = await ctx.api.reads.getCoachToday();
        if (t.day !== ctx.dates.today && t.day !== addDays(ctx.dates.today, -1))
          fail(`plan day ${t.day}, the run's day ${ctx.dates.today}`);
        if (!t.slots.length || t.slots.length > 4) fail(`${t.slots.length} slots`);
        const kinds = ['carry-over', 'new', 're-solve', 'stretch'];
        for (const s of t.slots)
          if (!kinds.includes(s.kind) || !s.reason.trim() || s.capMin !== 30)
            fail(`slot ${JSON.stringify(s)}`);
        if (!t.floor || t.mode !== 'general') fail(`floor/mode: ${JSON.stringify(t)}`);
        state.plan = t;
      },
    },
    {
      id: 'tools',
      title: 'tools/list has the coach’s tools; leetcode_today answers the same plan',
      entry: 'mcp',
      proves: ['today-mcp'],
      async run(ctx) {
        const names = await ctx.mcp.reads.toolsList();
        for (const n of [
          'leetcode_today',
          'mark_peeked',
          'set_cause_tag',
          'swap_slot',
          'log_attempt',
        ])
          if (!names.includes(n)) fail(`tools/list has no ${n}`);
        const t = (await ctx.mcp.reads.leetcodeToday()) as DevCoachToday & {
          rules?: Record<string, string>;
        };
        if (t.day !== today() || !same(slugs(t), slugs(plan())))
          fail(`leetcode_today ${slugs(t).join(',')} vs the API's ${slugs(plan()).join(',')}`);
        if (!t.rules?.['re-solve']?.includes('no hints'))
          fail('leetcode_today has no coaching rules');
      },
    },
    {
      id: 'start-on-slot',
      title: 'Link a roll; Start a sitting on the first open slot’s problem',
      entry: 'api',
      proves: ['slot-in-progress'],
      async run(ctx) {
        const slot = plan().slots.find((s) => s.status === 'open') ?? fail('no open slot to start');
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'roll'),
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        const { sitting } = await ctx.api.writes.lcSittingStart(start(slot.slug, slot.title));
        Object.assign(state, {
          slotSlug: slot.slug,
          slotKind: slot.kind,
          sittingId: sitting.id,
          repId: sitting.repTaskId,
        });
        const t = await ctx.api.reads.getCoachToday();
        const now = t.slots.find((s) => s.slug === slot.slug);
        if (now?.status !== 'in-progress' || now.sittingId !== sitting.id)
          fail(`slot after Start: ${JSON.stringify(now)}`);
      },
    },
    {
      id: 'live-slot',
      title: 'live_sitting names the sitting’s slot',
      entry: 'mcp',
      proves: ['live-slot'],
      async run(ctx) {
        const live = await ctx.mcp.reads.liveSitting();
        if (!live.active || live.sitting?.id !== state.sittingId)
          fail('live_sitting isn’t on this run’s sitting');
        const slot = live.slot ?? fail('live_sitting has no slot');
        if (
          slot.kind !== state.slotKind ||
          slot.capMin !== 30 ||
          slot.overCap ||
          !slot.rules.trim()
        )
          fail(`slot: ${JSON.stringify(slot)}`);
        if (live.trace !== null) fail(`trace before any coach event: ${String(live.trace)}`);
      },
    },
    {
      id: 'finish-slot',
      title: 'Accepted submit and Done: the slot is done; a patched cause survives a review save',
      entry: 'api',
      proves: ['slot-done', 'review-merge'],
      async run(ctx) {
        await finish(ctx, state.sittingId, state.repId);
        const t = await ctx.api.reads.getCoachToday();
        const slot = t.slots.find((s) => s.slug === state.slotSlug);
        if (slot?.status !== 'done' || slot.outcome !== 'clean')
          fail(`slot after Done: ${JSON.stringify(slot)}`);
        if (!same(slugs(t), slugs(plan()))) fail('the plan’s problems moved after a sitting');
        await ctx.api.writes.patchSittingReview(state.sittingId, { cause: 'boundary' });
        const saved = await ctx.api.writes.setSittingReview(state.sittingId, {
          insight: `devcheck ${ctx.nonce}`,
          help: 'none',
          mistakes: [],
          howItWent: null,
          tags: [],
          draftUsed: false,
        });
        const cause = (saved.review as { cause?: string } | null | undefined)?.cause;
        if (cause !== 'boundary') fail(`cause after a form save: ${String(cause)}`);
      },
    },
    {
      id: 'off-plan-start',
      title: 'Start a sitting on a problem off the plan',
      entry: 'api',
      async run(ctx) {
        state.offBefore = await ctx.api.reads.getCoachToday();
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slugOf(ctx, 'off'), titleOf(ctx, 'off')),
        );
        Object.assign(state, { offId: sitting.id, offRep: sitting.repTaskId });
      },
    },
    {
      id: 'off-plan-mcp',
      title: 'mark_peeked and set_cause_tag on the open off-plan sitting',
      entry: 'mcp',
      proves: ['mcp-peek-sitting', 'mcp-cause'],
      async run(ctx) {
        const p = await ctx.mcp.writes.markPeeked({ sittingId: state.offId });
        if (p.sittingId !== state.offId || p.attemptId)
          fail(`mark_peeked on a sitting: ${JSON.stringify(p)}`);
        if (p.nextDue?.dueDay !== addDays(today(), 1) || p.nextDue.track !== 'retry')
          fail(`mark_peeked's due: ${JSON.stringify(p.nextDue)}`);
        const c = await ctx.mcp.writes.setCauseTag({ sittingId: state.offId, cause: 'boundary' });
        const review = c.review as { cause?: string; help?: string } | null;
        if (review?.cause !== 'boundary' || review.help !== 'solution')
          fail(`set_cause_tag: ${JSON.stringify(c)}`);
        // The app form's Save landing after the peek, without help: the peek and the cause stay.
        const saved = await ctx.api.writes.setSittingReview(state.offId, {
          insight: `devcheck ${ctx.nonce} off`,
          mistakes: [],
          howItWent: null,
          tags: [],
          draftUsed: false,
        });
        const kept = saved.review as { cause?: string; help?: string } | null | undefined;
        if (kept?.help !== 'solution' || kept.cause !== 'boundary')
          fail(`a save without help: ${JSON.stringify(kept)}`);
      },
    },
    {
      id: 'off-plan-finish',
      title: 'Done on the off-plan sitting: it’s off the plan, the slots and due list unchanged',
      entry: 'api',
      proves: ['off-plan'],
      async run(ctx) {
        await finish(ctx, state.offId, state.offRep);
        const before = state.offBefore ?? fail('no plan before the off-plan Start');
        const t = await ctx.api.reads.getCoachToday();
        if (!t.offPlan.some((o) => o.sittingId === state.offId))
          fail('the off-plan sitting isn’t in offPlan');
        if (!same(slugs(t), slugs(before))) fail('an off-plan sitting moved the slots');
        if (!same(due(t), due(before)))
          fail(`due changed: ${due(before).join(',')} → ${due(t).join(',')}`);
      },
    },
    {
      id: 'peeked',
      title: 'mark_peeked on a problem with no sitting today, twice',
      entry: 'mcp',
      proves: ['mcp-peeked'],
      async run(ctx) {
        const slug = slugOf(ctx, 'peek');
        const a = await ctx.mcp.writes.markPeeked({ slug });
        if (
          !a.attemptId ||
          a.nextDue?.dueDay !== addDays(today(), 1) ||
          a.nextDue.track !== 'retry'
        )
          fail(`mark_peeked: ${JSON.stringify(a)}`);
        const b = await ctx.mcp.writes.markPeeked({ slug });
        if (b.attemptId !== a.attemptId) fail('a repeated mark_peeked logged a second attempt');
        const rec = (await ctx.api.reads.listProblemRecords()).find((r) => r.slug === slug);
        if (!rec?.peeked) fail('the record isn’t peeked');
      },
    },
    {
      id: 'swap',
      title: 'swap_slot on an open slot then restore; skip then restore',
      entry: 'mcp',
      proves: ['mcp-swap', 'mcp-skip'],
      async run(ctx) {
        const t0 = await ctx.mcp.reads.leetcodeToday();
        const open = t0.slots.filter((s) => s.status === 'open');
        const slot =
          [...open].reverse().find((s) => s.kind !== 're-solve') ??
          open[0] ??
          fail('no open slot to swap');
        const t1 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'swap',
        });
        const swapped =
          t1.slots.find((s) => s.swappedFrom === slot.slug && s.slug !== slot.slug) ??
          fail(`no swapped slot: ${slugs(t1).join(',')}`);
        // The default swap takes an unseen problem: a stretch slot stays a stretch, any other is new.
        const wantKind = slot.kind === 'stretch' ? 'stretch' : 'new';
        if (swapped.kind !== wantKind) fail(`swapped-in kind ${swapped.kind}, want ${wantKind}`);
        const t2 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: swapped.slug,
          action: 'restore',
        });
        if (!same(slugs(t2), slugs(t0)))
          fail(`restore: ${slugs(t2).join(',')} vs ${slugs(t0).join(',')}`);
        const t3 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'skip',
        });
        if (t3.slots.find((s) => s.slug === slot.slug)?.status !== 'skipped')
          fail('skip didn’t mark it');
        const t4 = await ctx.mcp.writes.swapSlot(t0.day, slot.slug, {
          slug: slot.slug,
          action: 'restore',
        });
        if (t4.slots.find((s) => s.slug === slot.slug)?.status !== 'open')
          fail('restore didn’t reopen it');
      },
    },
    {
      id: 'log',
      title: 'log_attempt: a clean attempt today',
      entry: 'mcp',
      proves: ['mcp-log'],
      async run(ctx) {
        const slug = slugOf(ctx, 'paper');
        const out = await ctx.mcp.writes.logAttempt([
          { slug, outcome: 'clean', minutes: 15, note: `devcheck ${ctx.nonce}` },
        ]);
        const a = out.attempts[0] ?? fail('log_attempt stored nothing');
        if (a.slug !== slug || a.nextDue?.dueDay !== addDays(today(), 3))
          fail(`log_attempt: ${JSON.stringify(a)}`);
        const t = await ctx.mcp.reads.leetcodeToday();
        if (t.momentum.lastActiveDay !== t.day || t.momentum.activeDays < 1)
          fail(`momentum: ${JSON.stringify(t.momentum)}`);
      },
    },
    {
      id: 'floor-focus',
      title: 'Floor on and off; a focus override on, then cleared',
      entry: 'api',
      proves: ['floor-focus'],
      async run(ctx) {
        const w = ctx.api.writes;
        if ((await w.setCoachFloor(today(), true)).floor?.on !== true)
          fail('the floor didn’t turn on');
        if ((await w.setCoachFloor(today(), false)).floor?.on !== false)
          fail('the floor didn’t turn off');
        // Only this scenario sets a focus on the test user, so clearing "the" override clears this run's.
        const f = await w.setCoachFocus('intervals');
        if (f?.pattern !== 'intervals' || f.sinceDay !== today())
          fail(`focus: ${JSON.stringify(f)}`);
        const held = await ctx.api.reads.getCoachToday();
        if (
          held.focus.pattern !== 'intervals' ||
          held.focus.source !== 'override' ||
          held.focus.day !== 1
        )
          fail(`focus in the plan: ${JSON.stringify(held.focus)}`);
        if ((await w.setCoachFocus(null)) !== null) fail('clearing the focus answered a row');
        if ((await ctx.api.reads.getCoachToday()).focus.source !== 'engine')
          fail('the focus didn’t clear');
      },
    },
    {
      id: 'bad-args',
      title: 'Bad arguments and an unknown slot write nothing',
      entry: 'mcp',
      proves: ['mcp-bad-args'],
      async run(ctx) {
        const before = (await ctx.api.reads.listCoachAttempts()).length;
        await expectParamError('mark_peeked {}', () => ctx.mcp.writes.markPeeked({}));
        await expectParamError('log_attempt []', () => ctx.mcp.writes.logAttempt([]));
        await expectParamError('swap_slot flip', () =>
          ctx.mcp.writes.swapSlot(today(), slugOf(ctx, 'none'), {
            slug: slugOf(ctx, 'none'),
            action: 'flip',
          }),
        );
        try {
          await ctx.mcp.writes.swapSlot(today(), slugOf(ctx, 'none'), {
            slug: slugOf(ctx, 'none'),
            action: 'skip',
          });
          fail('a skip on no slot was accepted');
        } catch (err) {
          if (!/No slot/.test(String(err))) throw err;
        }
        if ((await ctx.api.reads.listCoachAttempts()).length !== before)
          fail('a refused call wrote an attempt');
      },
    },
    {
      id: 'ownership',
      title: 'A peek and a cause aimed at a sitting id that isn’t the user’s are refused',
      entry: 'mcp',
      proves: ['ownership'],
      async run(ctx) {
        const stranger = devUlid();
        const before = (await ctx.api.reads.listCoachAttempts()).length;
        try {
          await ctx.mcp.writes.markPeekedUnknown(stranger);
          fail('mark_peeked on an unknown sitting was accepted');
        } catch (err) {
          if (!/Not found/.test(String(err))) throw err;
        }
        try {
          await ctx.mcp.writes.setCauseTagUnknown(stranger);
          fail('set_cause_tag on an unknown sitting was accepted');
        } catch (err) {
          if (!/Not found/.test(String(err))) throw err;
        }
        if ((await ctx.api.reads.listSittings()).some((x) => x.id === stranger))
          fail('a refused patch made a sitting');
        if ((await ctx.api.reads.listCoachAttempts()).length !== before)
          fail('a refused peek wrote an attempt');
      },
    },
    {
      id: 'test-sitting',
      title: 'A short unaccepted sitting and a flagged one never become problem records',
      entry: 'api',
      proves: ['test-sitting'],
      async run(ctx) {
        const short = slugOf(ctx, 'short');
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(short, titleOf(ctx, 'short')),
        );
        await finish(ctx, sitting.id, sitting.repTaskId, false);
        await ctx.api.writes.patchSittingReview(state.sittingId, { test: true });
        const records = await ctx.api.reads.listProblemRecords();
        if (records.some((r) => r.slug === short))
          fail('a 1-minute sitting with no accept counted');
        if (records.some((r) => r.sittingIds.includes(state.sittingId)))
          fail('the flagged sitting still counts');
        await ctx.api.writes.linkLeetcodeRoll(null); // for the scenarios after
      },
    },
    {
      id: 'patterns-mcp',
      title: 'coach_stats carries the Patterns tab’s per-pattern detail',
      entry: 'mcp',
      proves: ['patterns-mcp'],
      async run(ctx) {
        // This run's earlier sittings and logged attempts guarantee at least one pattern row.
        const rows = (await ctx.mcp.reads.coachStats()).patterns;
        if (!rows.length) fail('coach_stats has no pattern rows after this run’s attempts');
        for (const p of rows)
          for (const k of ['submitsPerTry', 'runBeforeSubmit', 'traced', 'weeks'] as const)
            if (!(k in p)) fail(`coach_stats ${p.patternId} lacks ${k}: ${JSON.stringify(p)}`);
      },
    },
    {
      id: 'patterns',
      title:
        'Recruiting › Patterns: the ranking, failed reads, a refused write, Set as focus and back, 390 px',
      entry: 'ui',
      proves: [
        'patterns-table',
        'patterns-small-counts',
        'patterns-set-focus',
        'patterns-390',
        'patterns-load-error',
        'patterns-focus-load-error',
        'patterns-focus-refused',
        'patterns-sittings-unchanged',
      ],
      async run(ctx) {
        const stats = await ctx.api.reads.getCoachStats();
        const row = (p: string) => ctx.page.locator(`li[data-pattern="${p}"]`);
        const focusRow = (p: string) =>
          ctx.page.locator(`li[data-pattern="${p}"][aria-current="true"]`);
        const setButton = (p: string) => row(p).getByRole('button', { name: /^Set as focus/ });
        const list = ctx.page.getByRole('list', { name: 'Weakest first tries first' });

        // A failed stats read first: the error with Retry, no list; released, Retry recovers.
        const down = await ctx.intercept('getCoachStats', { status: 500 });
        await ctx.ui.goto('/recruiting/patterns');
        await ctx.ui.expectText('Couldn’t load the patterns.');
        if (await list.count()) fail('the ranking rendered over a failed read');
        await ctx.shot('patterns-load-error');
        await down.release();
        await ctx.page.getByRole('button', { name: 'Retry' }).click();
        await list.waitFor();
        const want = PATTERN_COUNT + (stats.patterns.some((p) => p.pattern === 'other') ? 1 : 0);
        const shown = await list.getByRole('listitem').count();
        if (shown !== want) fail(`${shown} pattern rows, want ${want}`);
        const today = await ctx.api.reads.getCoachToday();
        await focusRow(today.focus.pattern).waitFor();
        // Every practised roadmap row reads the server's count; a percentage only from 5 tries. This run's off-plan
        // sitting (an Array-tagged problem) guarantees one row under 5.
        let pct = 0;
        const practised = stats.patterns.filter((x) => x.pattern !== 'other');
        if (!practised.length)
          fail('no practised roadmap pattern to check: the off-plan sitting didn’t count');
        for (const p of practised) {
          const { hit, of } = p.firstTry;
          const text = (await row(p.pattern).textContent()) ?? '';
          const base = `First try ${hit} of ${of}`;
          const full = of >= 5 ? `${base} (${Math.round((hit / of) * 100)}%)` : base;
          if (!text.includes(full)) fail(`${p.pattern}: the row reads "${text}", want "${full}"`);
          if (of < 5 && text.includes(`${base} (`))
            fail(`${p.pattern}: a percentage under 5 tries`);
          if (of >= 5) pct += 1;
        }
        ctx.log(
          `${practised.length} practised roadmap pattern(s) checked, ${pct} with a percentage`,
        );
        await ctx.ui.settle();
        await ctx.shot('patterns');

        // A failed focus read: says so, the buttons wait; Retry recovers.
        const noFocus = await ctx.intercept('getCoachToday', { status: 500 });
        await ctx.ui.goto('/recruiting/patterns');
        await ctx.ui.expectText('Couldn’t load the focus.');
        await list.waitFor();
        const firstSet = list.getByRole('button', { name: /^Set as focus/ }).first();
        if (!(await firstSet.isDisabled())) fail('Set as focus is live with no focus read');
        await ctx.shot('patterns-focus-load-error');
        await noFocus.release();
        await ctx.page.getByRole('button', { name: 'Retry' }).click();
        await focusRow(today.focus.pattern).waitFor();

        const [a, b] = stats.ranking.filter((p) => p !== today.focus.pattern);
        if (!a || !b) fail(`too few ranked patterns: ${stats.ranking.join(', ')}`);
        // The override is ledgered before the page can write one: set through the API on another ranked pattern
        // (the focus row is one id), so cleanup clears it whatever the page leaves.
        await ctx.api.writes.setCoachFocus(a!);
        await ctx.ui.goto('/recruiting/patterns');
        await focusRow(a!).waitFor();
        // A refused write (the server's 400 with its reason) says why inline and moves nothing.
        const refuse = await ctx.intercept('setCoachFocus', {
          status: 400,
          times: 1,
          body: { error: 'devcheck refused this focus' },
        });
        await setButton(b!).click();
        await ctx.ui.expectText('devcheck refused this focus. Nothing changed.');
        await refuse.release();
        if ((await ctx.api.reads.getCoachToday()).focus.pattern !== a)
          fail('a refused focus write moved the focus');
        await ctx.shot('patterns-focus-refused');

        // Set as focus through the page, then back to the coach's pick.
        await setButton(b!).click();
        await focusRow(b!).waitFor();
        await ctx.ui.expectText(/Focus · .* · day 1 of 3/);
        const held = (await ctx.api.reads.getCoachToday()).focus;
        if (held.pattern !== b || held.day !== 1 || held.source !== 'override')
          fail(`the plan's focus after Set as focus: ${JSON.stringify(held)}`);
        await ctx.shot('patterns-focus-set');
        const back = ctx.page.getByRole('button', { name: 'Back to the coach’s pick' });
        await back.click();
        await back.waitFor({ state: 'hidden' });
        if ((await ctx.api.reads.getCoachToday()).focus.source !== 'engine')
          fail('“Back to the coach’s pick” left the override');
        await ctx.api.writes.setCoachFocus(null); // resolves the ledger entry; a no-op on the server now

        // 390 px as the page first opens: every row's button on screen, no sideways scroll, light then dark.
        await ctx.page.setViewportSize({ width: 390, height: 844 });
        try {
          await ctx.ui.goto('/recruiting/patterns');
          await list.waitFor();
          for (const theme of ['light', 'dark'] as const) {
            await ctx.ui.setTheme(theme);
            const wide = await ctx.page.evaluate<boolean>(
              '(() => document.documentElement.scrollWidth > window.innerWidth)()',
            );
            if (wide) fail(`${theme}: the page scrolls sideways at 390`);
            const buttons = ctx.page.getByRole('button', { name: /^Set as focus/ });
            for (let i = 0; i < (await buttons.count()); i++) {
              const btn = buttons.nth(i);
              await btn.scrollIntoViewIfNeeded();
              const box = await btn.boundingBox();
              if (!box || box.x < 0 || box.x + box.width > 390)
                fail(`${theme}: button ${i + 1} is off screen at 390`);
            }
          }
          await ctx.ui.settle();
          await ctx.shot('patterns-390');
        } catch (err) {
          await ctx.shot('patterns-fail-at-390').catch(() => null);
          throw err;
        } finally {
          await ctx.ui.setTheme('light');
          await ctx.page.setViewportSize(PHONE);
        }

        // The Sittings tab beside it still lists this run's sittings, without the Patterns list.
        await ctx.ui.goto('/recruiting');
        // Scoped to the list: the Today card above it links the same off-plan sitting.
        await ctx.page
          .getByRole('region', { name: 'All sittings' })
          .locator(`a[href$="/recruiting/sittings/${state.offId}"]`)
          .waitFor();
        if (await list.count()) fail('the Patterns list shows on the Sittings tab');
      },
    },
    {
      id: 'scheduler',
      title: 'Backdated attempts through log_attempt: each lands where the table says',
      entry: 'mcp',
      proves: ['scheduler'],
      async run(ctx) {
        const d = (n: number) => addDays(today(), n);
        const [step, solved, failed, grad] = ['step', 'solved', 'failed', 'grad'].map((w) =>
          slugOf(ctx, w),
        );
        const at = (slug: string, outcome: string, n: number) => ({ slug, outcome, day: d(n) });
        const out = await ctx.mcp.writes.logAttempt([
          at(step!, 'clean', -10), // clean track, due -7 …
          at(step!, 'clean', -7), // … a clean re-solve steps on: due -7 + 7 = today
          at(solved!, 'clean', -6), // due -3 …
          at(solved!, 'solved', -3), // … solved repeats the gap: -3 + 3 = today
          at(failed!, 'clean', -5),
          at(failed!, 'failed', -3), // the peeked track from the start: -3 + 1
          at(grad!, 'clean', -40),
          at(grad!, 'clean', -37),
          at(grad!, 'clean', -30),
          at(grad!, 'clean', -16), // past the last step: graduated, nothing due
        ]);
        const next = (slug: string) => out.attempts.find((a) => a.slug === slug)?.nextDue ?? null;
        const want: [string, { dueDay: string; track: string } | null][] = [
          [step!, { dueDay: today(), track: 'clean' }],
          [solved!, { dueDay: today(), track: 'clean' }],
          [failed!, { dueDay: d(-2), track: 'retry' }],
          [grad!, null],
        ];
        for (const [slug, w] of want) {
          const got = next(slug);
          if (JSON.stringify(got && { dueDay: got.dueDay, track: got.track }) !== JSON.stringify(w))
            fail(`${slug}: ${JSON.stringify(got)}, want ${JSON.stringify(w)}`);
        }
      },
    },

    // --- The app (PR A-app). After the scheduler: the plan these read is whatever it left, read live. ---
    {
      id: 'ui-card',
      title: 'The Today card shows the API’s slots with their kind, cap, reason and link',
      entry: 'ui',
      proves: ['ui-card'],
      async run(ctx) {
        const t = await ctx.api.reads.getCoachToday();
        const c = await todayCard(ctx);
        for (const s of t.slots) {
          const link = c.getByRole('link', { name: s.title, exact: true }).first();
          await link.waitFor({ state: 'visible', timeout: 15_000 });
          if ((await link.getAttribute('href')) !== `https://leetcode.com/problems/${s.slug}/`)
            fail(`${s.slug}: link ${String(await link.getAttribute('href'))}`);
          if (!(await c.getByText(s.reason, { exact: true }).count()))
            fail(`no reason for ${s.slug}`);
        }
        if (!(await c.getByText(/· 30 min$/).count())) fail('no slot shows the 30-minute cap');
        await c
          .getByText(/ · day \d of 3/)
          .first()
          .waitFor({ timeout: 5_000 });
        await c.getByText(/of 7 days practised this week/).waitFor({ timeout: 5_000 });
        // The 48-hour list: a re-solve due beyond today's live slots is there (the scheduler step leaves some).
        const due = dueBeyond(t)[0];
        if (due) {
          const list = c.getByRole('region', { name: 'Next 48 hours' });
          const title = (due as { title?: string }).title ?? fail('a due item with no title');
          await list.getByText(title).first().waitFor({ timeout: 5_000 }); // its row adds " · pattern"
        }
        await ctx.shot('lc-coach-today-card');
      },
    },
    {
      id: 'ui-swap',
      title: 'Another (or Skip) on a slot, then Restore — through the card',
      entry: 'ui',
      proves: ['ui-swap', 'ui-slot-focus'],
      async run(ctx) {
        const t0 = await ctx.api.reads.getCoachToday();
        const open = t0.slots.filter((s) => s.status === 'open' && !s.swappedFrom);
        const slot =
          open.find(
            (s) => (s as DevCoachSlot & { alternatives?: unknown[] }).alternatives?.length,
          ) ??
          open[0] ??
          fail('no open slot to change');
        const canSwap = !!(slot as DevCoachSlot & { alternatives?: unknown[] }).alternatives
          ?.length;
        // The UI's change has no id of its own: a ledgered skip on the same slot first records it, so cleanup
        // restores the slot whatever the UI step leaves (mcp.ts swapSlot; api.ts coachSlotId).
        await ctx.mcp.writes.swapSlot(t0.day, slot.slug, { slug: slot.slug, action: 'skip' });
        const c = await todayCard(ctx);
        await c.getByRole('button', { name: `Restore — ${slot.title}` }).click();
        await until('the slot reopened', async () =>
          (await ctx.api.reads.getCoachToday()).slots.some(
            (s) => s.slug === slot.slug && s.status === 'open',
          ),
        );
        await focusOn(ctx, openButton(slot.title), 'after Restore');
        if (canSwap) {
          await c.getByRole('button', { name: `Another problem — ${slot.title}` }).click();
          let swapped: DevCoachSlot | undefined;
          await until('the swap', async () => {
            swapped = (await ctx.api.reads.getCoachToday()).slots.find(
              (s) => s.swappedFrom === slot.slug,
            );
            return !!swapped;
          });
          await c.getByRole('link', { name: swapped!.title, exact: true }).first().waitFor();
          await ctx.shot('lc-coach-swapped');
          await focusOn(ctx, `— ${swapped!.title}`, 'after Another');
          await c.getByRole('button', { name: `Restore — ${swapped!.title}` }).click();
        } else {
          ctx.log(`no easier problem left for ${slot.slug}: Skip instead of Another`);
          await c.getByRole('button', { name: `Skip today — ${slot.title}` }).click();
          await c.getByText('skipped today').first().waitFor({ timeout: 10_000 });
          await focusOn(ctx, `Restore — ${slot.title}`, 'after Skip');
          await c.getByRole('button', { name: `Restore — ${slot.title}` }).click();
        }
        await until('the original back', async () =>
          same(slugs(await ctx.api.reads.getCoachToday()), slugs(t0)),
        );
        await focusOn(ctx, openButton(slot.title), 'after the last Restore');
        // Resolves the ledger entry (a restore with nothing to undo changes nothing).
        await ctx.mcp.writes.swapSlot(t0.day, slot.slug, { slug: slot.slug, action: 'restore' });
      },
    },
    {
      id: 'ui-home-absent',
      title: 'No roll linked: Home’s morning has no LeetCode line',
      entry: 'ui',
      proves: ['ui-home-absent'],
      async run(ctx) {
        if ((await ctx.api.reads.getSettings()).leetcodeRollId != null)
          fail('a LeetCode roll is linked — the test-sitting step should have unlinked it');
        await morning(ctx);
        await new Promise((r) => setTimeout(r, 2_000)); // a line would need the plan's read: let it land
        if (await ctx.page.getByText(/^LeetCode · /).count()) fail('a LeetCode line with no roll');
      },
    },
    {
      id: 'ui-home',
      title: 'Link a roll: Home’s morning line reads the plan and links to the card',
      entry: 'ui',
      proves: ['ui-home'],
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'app-roll'),
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        await morning(ctx);
        const line = ctx.page.getByRole('link', { name: /^LeetCode · / });
        await line.waitFor({ state: 'visible', timeout: 15_000 });
        const text = (await line.textContent()) ?? '';
        if (/couldn’t load/.test(text)) fail(`the line: ${text}`);
        // The line names the plan's own numbers (recruitingHelpers.ts coachGlance).
        const t = await ctx.api.reads.getCoachToday();
        const live = t.slots.filter((x) => x.status !== 'skipped');
        const left = live.filter((x) => x.status !== 'done').length;
        const want =
          t.floor?.on && !t.floor.done
            ? 'floor day'
            : left === 0
              ? `${live.length} of ${live.length} done`
              : `${left} ${left < live.length ? 'left today' : 'today'}`;
        if (live.length && !text.includes(want)) fail(`the line "${text}" doesn’t say "${want}"`);
        const due = dueBeyond(t).length;
        if (due && !text.includes(`+${due} re-solve`))
          fail(`the line "${text}" doesn’t count ${due} due beyond the slots`);
        if ((await line.getAttribute('href')) !== '/recruiting')
          fail('the line doesn’t link to the card');
        await ctx.shot('lc-coach-home-line');
      },
    },
    {
      id: 'ui-review',
      title: 'Review form: Boundary and Peeked saved, read back after a reload and on the head',
      entry: 'ui',
      proves: ['ui-cause'],
      async run(ctx) {
        const slug = slugOf(ctx, 'review');
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slug, titleOf(ctx, 'review')),
        );
        await finish(ctx, sitting.id, sitting.repTaskId);
        app.reviewId = sitting.id;
        await ctx.ui.goto(`/recruiting/sittings/${sitting.id}`);
        const p = ctx.page;
        await p.getByRole('button', { name: 'Boundary', exact: true }).click();
        await p.getByRole('button', { name: 'Peeked', exact: true }).click();
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        await p.reload({ waitUntil: 'load' });
        for (const name of ['Boundary', 'Peeked']) {
          const b = p.getByRole('button', { name, exact: true });
          await b.waitFor({ timeout: 15_000 });
          if ((await b.getAttribute('aria-pressed')) !== 'true')
            fail(`${name} not pressed after reload`);
        }
        await ctx.shot('lc-coach-review-cause');
      },
    },
    {
      id: 'review-head',
      title: 'The form’s Save is on the head: the cause, and help as solution',
      entry: 'api',
      proves: ['review-cause-head'],
      async run(ctx) {
        const id = app.reviewId || fail('no review sitting — the ui-review step failed');
        const head = (await ctx.api.reads.listSittings()).find((x) => x.id === id);
        const r = head?.review as { cause?: string; help?: string } | null | undefined;
        if (r?.cause !== 'boundary' || r.help !== 'solution')
          fail(`head review: ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'ui-f169',
      title: 'F169: a form open before mark_peeked; the Save keeps the peek',
      entry: 'ui',
      proves: ['ui-f169'],
      async run(ctx) {
        const slug = slugOf(ctx, 'f169');
        const { sitting } = await ctx.api.writes.lcSittingStart(start(slug, titleOf(ctx, 'f169')));
        await finish(ctx, sitting.id, sitting.repTaskId);
        app.f169Id = sitting.id;
        await ctx.ui.goto(`/recruiting/sittings/${sitting.id}`);
        const p = ctx.page;
        const none = p.getByRole('button', { name: 'No help', exact: true });
        await none.waitFor({ timeout: 15_000 });
        if ((await none.getAttribute('aria-pressed')) !== 'true')
          fail('the form didn’t open on No help');
        await ctx.mcp.writes.markPeeked({ sittingId: sitting.id });
        await p.getByLabel('One-liner').fill(`devcheck ${ctx.nonce}`);
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        const head = (await ctx.api.reads.listSittings()).find((x) => x.id === sitting.id);
        const r = head?.review as { help?: string; insight?: string } | null | undefined;
        if (r?.help !== 'solution' || !r.insight)
          fail(`the Save dropped the peek: ${JSON.stringify(r)}`);
        const peeked = p.getByRole('button', { name: 'Peeked', exact: true });
        await until(
          'the form shows the peek',
          async () => (await peeked.getAttribute('aria-pressed')) === 'true',
        );
      },
    },
    {
      id: 'ui-suggested',
      title: 'A failed first submit, no Run: the suggested No trace, saved untouched, then cleared',
      entry: 'ui',
      proves: ['ui-suggested'],
      async run(ctx) {
        const slug = slugOf(ctx, 'suggest');
        const { sitting } = await ctx.api.writes.lcSittingStart(
          start(slug, titleOf(ctx, 'suggest')),
        );
        const t = Date.now();
        await ctx.api.writes.lcSittingEvents(sitting.id, [wrong(t), accepted(t + 1_000)]);
        await finish(ctx, sitting.id, sitting.repTaskId, false); // accepted above; Done with the actual
        const cause = async () => {
          const head = (await ctx.api.reads.listSittings()).find((x) => x.id === sitting.id);
          return (head?.review as { cause?: string | null } | null | undefined)?.cause ?? null;
        };
        await ctx.ui.goto(`/recruiting/sittings/${sitting.id}`);
        const p = ctx.page;
        const chip = p.getByRole('button', { name: 'No trace', exact: true });
        await chip.waitFor({ timeout: 15_000 });
        if ((await chip.getAttribute('aria-pressed')) !== 'true') fail('No trace isn’t suggested');
        await p.getByText('· suggested').waitFor({ timeout: 5_000 });
        await ctx.shot('lc-coach-review-suggested');
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        if ((await cause()) !== 'no-trace') fail(`untouched Save stored ${String(await cause())}`);
        await chip.click();
        await p.getByRole('button', { name: 'Save review' }).click();
        await until('the cleared cause saved', async () => (await cause()) === null);
        await p.reload({ waitUntil: 'load' });
        await chip.waitFor({ timeout: 15_000 });
        if ((await chip.getAttribute('aria-pressed')) !== 'false')
          fail('the cleared cause came back');
        if (await p.getByText('· suggested').count())
          fail('the suggestion came back after a clear');
      },
    },
    {
      id: 'ui-unreviewed',
      title: 'The card lists the F169 sitting under No cause yet, linking to its review',
      entry: 'ui',
      proves: ['ui-unreviewed'],
      async run(ctx) {
        const id = app.f169Id || fail('no F169 sitting — the ui-f169 step failed');
        const c = await todayCard(ctx);
        // Within its own line: an off-plan sitting is also listed under "Also today".
        const line = c.getByText(/^No cause yet:/);
        await line.waitFor({ timeout: 15_000 });
        const link = line.getByRole('link', { name: titleOf(ctx, 'f169'), exact: true });
        if ((await link.getAttribute('href')) !== `/recruiting/sittings/${id}`)
          fail(`its link: ${String(await link.getAttribute('href'))}`);
      },
    },
    {
      id: 'ui-failed',
      title: 'getCoachToday fails: the card says so with Retry; Retry recovers',
      entry: 'ui',
      proves: ['ui-failed'],
      async run(ctx) {
        const i = await ctx.intercept('getCoachToday', { status: 500 });
        await ctx.ui.goto('/recruiting');
        const c = ctx.page.getByRole('region', { name: 'Today’s practice' });
        await c.getByText('Couldn’t load today’s plan.').waitFor({ timeout: 30_000 });
        await ctx.shot('lc-coach-card-failed');
        await i.release();
        await c.getByRole('button', { name: 'Retry' }).click();
        await c
          .getByText(/ · day \d of 3/)
          .first()
          .waitFor({ timeout: 15_000 });
      },
    },
    {
      id: 'ui-home-failed',
      title: 'getCoachToday fails: Home’s morning shows one line linking to the card',
      entry: 'ui',
      proves: ['ui-home-failed'],
      async run(ctx) {
        const i = await ctx.intercept('getCoachToday', { status: 500 });
        try {
          await morning(ctx);
          const line = ctx.page.getByRole('link', { name: /^LeetCode · couldn’t load/ });
          await line.waitFor({ state: 'visible', timeout: 30_000 });
          if ((await line.getAttribute('href')) !== '/recruiting')
            fail('the failed line doesn’t link to the card');
          await ctx.shot('lc-coach-home-failed');
        } finally {
          await i.release();
        }
        await ctx.api.writes.linkLeetcodeRoll(null); // the roll ui-home linked: the last step that needs it
      },
    },
    {
      id: 'ui-floor',
      title: 'Full day, then Floor day, on the card',
      entry: 'ui',
      proves: ['ui-floor'],
      async run(ctx) {
        // The floor is ledgered through the API first (coachFloorId), so cleanup turns it off whatever the UI leaves.
        const day = (await ctx.api.writes.setCoachFloor(today(), true)).day;
        if (day !== today()) fail(`the plan's day moved: ${day}`);
        const c = await todayCard(ctx);
        await c.getByText(/Floor day: just/).waitFor({ timeout: 15_000 });
        await c.getByRole('button', { name: 'Full day', exact: true }).click();
        await c.getByText(/Short on time\? Floor:/).waitFor({ timeout: 15_000 });
        if ((await ctx.api.reads.getCoachToday()).floor?.on !== false) fail('Full day left it on');
        await c.getByRole('button', { name: 'Floor day', exact: true }).click();
        await c.getByText(/Floor day: just/).waitFor({ timeout: 15_000 });
        if ((await ctx.api.reads.getCoachToday()).floor?.on !== true)
          fail('Floor day didn’t turn it on');
        await ctx.shot('lc-coach-floor-on');
        await ctx.api.writes.setCoachFloor(today(), false);
      },
    },
    {
      id: 'ui-focus',
      title: 'The focus picker: the coach’s pick, then Intervals',
      entry: 'ui',
      proves: ['ui-focus'],
      async run(ctx) {
        // Ledgered through the API first (coachFocusId), so cleanup clears whatever the UI leaves.
        await ctx.api.writes.setCoachFocus('intervals');
        const c = await todayCard(ctx);
        const pick = async (label: string) => {
          await c.getByRole('button', { name: 'Change', exact: true }).click();
          await c.getByLabel('Focus pattern').selectOption({ label });
        };
        await c.getByText('Intervals · day 1 of 3 · your pick').waitFor({ timeout: 15_000 });
        await pick('The coach’s pick');
        await until(
          'the override cleared',
          async () => (await ctx.api.reads.getCoachToday()).focus.source === 'engine',
        );
        await pick('Intervals');
        await c.getByText('Intervals · day 1 of 3 · your pick').waitFor({ timeout: 15_000 });
        await c.getByRole('button', { name: 'Change', exact: true }).click();
        await c.getByRole('button', { name: 'Cancel', exact: true }).click();
        if (await c.getByLabel('Focus pattern').count()) fail('Cancel left the picker open');
        await ctx.shot('lc-coach-focus-pick');
        await ctx.api.writes.setCoachFocus(null);
      },
    },

    // --- PR B. After the app steps: reads over what the scheduler logged; the draft last. ---
    {
      id: 'b-reads',
      title: 'The history, stats and story reads over what the scheduler step logged',
      entry: 'mcp',
      proves: ['mcp-tools-b', 'mcp-due', 'mcp-problem', 'mcp-stats', 'mcp-stories'],
      async run(ctx) {
        const names = await ctx.mcp.reads.toolsList();
        for (const n of [
          'list_problems',
          'get_problem',
          'coach_stats',
          'list_stories',
          'set_focus_pattern',
          'delete_attempt',
        ])
          if (!names.includes(n)) fail(`tools/list has no ${n}`);
        const d = (n: number) => addDays(today(), n);
        const [step, solved, failed, grad] = ['step', 'solved', 'failed', 'grad'].map((w) =>
          slugOf(ctx, w),
        );
        // The scheduler step left step and solved due today, failed due two days ago, grad graduated.
        const due = await ctx.mcp.reads.listProblems({ due: true, pattern: 'other', limit: 100 });
        const mine = due.problems
          .map((p) => p.slug)
          .filter((x) => [step, solved, failed, grad].includes(x));
        if (
          mine[0] !== failed ||
          !mine.includes(step!) ||
          !mine.includes(solved!) ||
          mine.includes(grad!)
        )
          fail(`due list: ${mine.join(',')}`);
        for (let i = 1; i < due.problems.length; i++)
          if (
            (due.problems[i]!.reSolve?.dueDay ?? '') < (due.problems[i - 1]!.reSolve?.dueDay ?? '')
          )
            fail('the due list isn’t oldest first');
        const g = await ctx.mcp.reads.getProblem({ slug: grad });
        const tries = g.tries ?? [];
        if (g.record?.attempts !== 4 || tries.length !== 4 || g.problem.onRoadmap)
          fail(`get_problem: ${JSON.stringify(g).slice(0, 300)}`);
        if (tries.some((x) => x.attemptIds.length !== 1)) fail('a try has no logged-attempt id');
        const all = await ctx.mcp.reads.coachStats({ from: d(-40) });
        if (all.attempts < 10 || all.firstTry.of < 4 || all.resolve.of < 6 || !all.note)
          fail(`coach_stats: ${JSON.stringify(all).slice(0, 300)}`);
        if (!all.patterns.some((p) => p.patternId === 'other'))
          fail('coach_stats has no pattern for the logged problems');
        const weeks = all.weeks.map((w) => w.week);
        if (weeks.join() !== [...weeks].sort().join()) fail(`weeks out of order: ${weeks.join()}`);
        const one = await ctx.mcp.reads.coachStats({ from: d(-40), to: d(-40) });
        if (one.to !== d(-40) || one.weeks.length !== 1 || one.firstTry.hit < 1)
          fail(`a one-day range: ${JSON.stringify(one).slice(0, 300)}`);
        const story = await ctx.api.writes.createStory(titleOf(ctx, 'story'));
        await ctx.api.writes.updateStory(story.id, {
          situation: `devcheck ${ctx.nonce}`,
          competencyTags: ['ownership'],
        });
        // The list read is eventually consistent: give a just-written story a moment.
        let listed:
          Awaited<ReturnType<typeof ctx.mcp.reads.listStories>>['stories'][number] | undefined;
        for (let i = 0; i < 20; i++) {
          listed = (await ctx.mcp.reads.listStories()).stories.find((x) => x.id === story.id);
          if (listed?.situation === `devcheck ${ctx.nonce}`) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (
          listed?.title !== titleOf(ctx, 'story') ||
          listed.situation !== `devcheck ${ctx.nonce}` ||
          listed.competencies.join() !== 'ownership'
        )
          fail(`list_stories: ${JSON.stringify(listed)}`);
      },
    },
    {
      id: 'b-focus',
      title: 'set_focus_pattern on, read back through leetcode_today, then cleared',
      entry: 'mcp',
      proves: ['mcp-focus'],
      async run(ctx) {
        const on = await ctx.mcp.writes.setFocusPattern('graphs');
        if (on.override?.since !== today() || on.focus.patternId !== 'graphs' || on.focus.day !== 1)
          fail(`set_focus_pattern: ${JSON.stringify(on)}`);
        const t = (await ctx.mcp.reads.leetcodeToday()) as DevCoachToday & {
          focus: { patternId?: string; source: string };
        };
        if (t.focus.patternId !== 'graphs' || t.focus.source !== 'override')
          fail(`leetcode_today's focus: ${JSON.stringify(t.focus)}`);
        const off = await ctx.mcp.writes.setFocusPattern(null);
        if (off.override !== null || off.focus.source !== 'engine')
          fail(`clearing: ${JSON.stringify(off)}`);
      },
    },
    {
      id: 'b-delete',
      title: 'delete_attempt on an attempt this run logged, twice; bad arguments',
      entry: 'mcp',
      proves: ['mcp-delete', 'mcp-b-bad-args'],
      async run(ctx) {
        const slug = slugOf(ctx, 'undo');
        const logged = await ctx.mcp.writes.logAttempt([{ slug, outcome: 'solved' }]);
        const id = logged.attempts[0]?.id ?? fail('log_attempt stored nothing');
        const gone = await ctx.mcp.writes.deleteAttempt(id);
        if (!gone.deleted || gone.slug !== slug) fail(`delete_attempt: ${JSON.stringify(gone)}`);
        if (
          (await ctx.mcp.reads.listProblems({ limit: 100 })).problems.some((p) => p.slug === slug)
        )
          fail('the deleted attempt’s problem is still listed');
        if ((await ctx.mcp.writes.deleteAttemptUnknown(id)).deleted)
          fail('a repeated delete_attempt said it deleted');
        const before = (await ctx.api.reads.listCoachAttempts()).length;
        if ((await ctx.mcp.writes.deleteAttemptUnknown(devUlid())).deleted)
          fail('delete_attempt on an id nobody logged said it deleted');
        await expectParamError('delete_attempt nope', () =>
          ctx.mcp.writes.deleteAttemptUnknown('nope'),
        );
        await expectParamError('set_focus_pattern graph', () =>
          ctx.mcp.writes.setFocusPattern('graph'),
        );
        await expectParamError('coach_stats from after to', () =>
          ctx.mcp.reads.coachStats({ from: today(), to: addDays(today(), -1) }),
        );
        await expectParamError('coach_stats from monday', () =>
          ctx.mcp.reads.coachStats({ from: 'monday' }),
        );
        await expectParamError('get_problem Two Sum', () =>
          ctx.mcp.reads.getProblem({ slug: 'Two Sum' }),
        );
        await expectParamError('list_problems limit 0', () =>
          ctx.mcp.reads.listProblems({ limit: 0 }),
        );
        try {
          await ctx.mcp.reads.getProblem({ slug: slugOf(ctx, 'never') });
          fail('get_problem on an unknown problem answered');
        } catch (err) {
          if (!/No record of/.test(String(err))) throw err;
        }
        // Only a growth is a write: a stale read may still count the attempt deleted just above.
        if ((await ctx.api.reads.listCoachAttempts()).length > before)
          fail('a refused call wrote an attempt');
        if ((await ctx.api.reads.getCoachToday()).focus.source !== 'engine')
          fail('a refused focus call set a focus');
      },
    },
    {
      id: 'progress-mcp',
      title:
        'log_attempt historical: the schema, three refusals, then a history-only solve 400 days back',
      entry: 'mcp',
      proves: ['progress-schema', 'progress-history-bad', 'progress-history'],
      async run(ctx) {
        // A catalog problem this account hasn't touched, logged as solved before (400 days back), ledgered by id:
        // progress-undo deletes it, and cleanup does if a step fails first.
        const records = await ctx.api.reads.listProblemRecords();
        const pick =
          PROGRESS_PICKS.find((p) => !records.some((r) => r.slug === p.slug)) ??
          fail('every Progress candidate already has a record on this account');
        const planBefore = await ctx.api.reads.getCoachToday();
        const statsBefore = await ctx.api.reads.getCoachStats();
        const note = `devcheck ${ctx.nonce}`;

        // The schema, then the refusals: nothing written.
        const tool = (await ctx.mcp.reads.toolSchemas()).find((t) => t.name === 'log_attempt');
        const item = (
          tool?.inputSchema as {
            properties?: { attempts?: { items?: { properties?: Record<string, unknown> } } };
          }
        )?.properties?.attempts?.items?.properties;
        if (!item || !('historical' in item)) fail('log_attempt has no historical in tools/list');
        const countBefore = (await ctx.api.reads.listCoachAttempts()).length;
        const refused = async (what: string, a: Record<string, unknown>, want: RegExp) => {
          try {
            await ctx.mcp.writes.logAttempt([a]);
          } catch (err) {
            if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
            if (want.test(String(err))) return;
            throw err;
          }
          fail(`${what}: accepted`);
        };
        await refused(
          'historical "yes"',
          { slug: pick.slug, outcome: 'solved', historical: 'yes' },
          /historical must be true or false/,
        );
        await refused(
          'a historical day 11 years back',
          { slug: pick.slug, outcome: 'solved', historical: true, day: addDays(today(), -4020) },
          /last 10 years/,
        );
        await refused(
          'a historical day of today',
          { slug: pick.slug, outcome: 'solved', historical: true, day: today() },
          /dated before today/,
        );
        await refused(
          'a live day 61 days back',
          { slug: pick.slug, outcome: 'solved', day: addDays(today(), -61) },
          /last 60 days/,
        );
        if ((await ctx.api.reads.listCoachAttempts()).length !== countBefore)
          fail('a refused log_attempt wrote an attempt');

        const out = await ctx.mcp.writes.logAttempt([
          {
            slug: pick.slug,
            outcome: 'solved',
            historical: true,
            day: addDays(today(), -400),
            note,
          },
        ]);
        const logged = out.attempts[0] ?? fail('log_attempt stored nothing');
        if (logged.historical !== true || logged.nextDue !== null)
          fail(`the history-only attempt: ${JSON.stringify(logged)}`);
        const read = await ctx.mcp.reads.getProblem({ slug: pick.slug });
        if (!read.tries?.some((t) => t.historical === true && t.attemptIds.includes(logged.id)))
          fail(`get_problem's tries lack the history-only one: ${JSON.stringify(read.tries)}`);
        progress.pick = pick;
        progress.id = logged.id;
        progress.note = note;
        progress.planBefore = planBefore;
        progress.statsBefore = statsBefore;
      },
    },
    {
      id: 'progress-neighbours',
      title:
        'The history-only solve moved nothing: the due list, the next 48 h, momentum, the stats, the slots',
      entry: 'api',
      proves: ['progress-history-neighbours'],
      async run(ctx) {
        const { pick, planBefore, statsBefore } = progressState();
        const after = await ctx.api.reads.getCoachToday();
        if (
          !same(due(after), due(planBefore)) ||
          !same(
            after.next48h.map((q) => q.slug),
            planBefore.next48h.map((q) => q.slug),
          ) ||
          JSON.stringify(after.momentum) !== JSON.stringify(planBefore.momentum) ||
          slugs(after).includes(pick.slug)
        )
          fail(`the plan moved: ${JSON.stringify({ before: planBefore, after })}`);
        const statsAfter = await ctx.api.reads.getCoachStats();
        const counts = (x: DevCoachStats) =>
          JSON.stringify({ attempts: x.attempts, firstTry: x.firstTry, resolve: x.resolve });
        if (counts(statsAfter) !== counts(statsBefore))
          fail(`stats moved: ${counts(statsBefore)} → ${counts(statsAfter)}`);
      },
    },
    {
      id: 'progress',
      title:
        'Recruiting › Progress: the map, Left only, off the list, Solves, a problem’s page, Trends, a failed read, 390 px; Premium in Settings',
      entry: 'ui',
      proves: [
        'progress-map',
        'progress-open',
        'progress-left',
        'progress-off-list',
        'progress-solves',
        'progress-problem',
        'progress-trends',
        'progress-390',
        'progress-desktop',
        'progress-load-error',
        'premium-toggle',
        'premium-off',
      ],
      async run(ctx) {
        const { pick, note } = progressState();
        const recs = await ctx.api.reads.listProblemRecords();
        const mine = recs.find((r) => r.slug === pick.slug);
        if (!mine?.historical || mine.schedule !== null)
          fail(`the record: ${JSON.stringify(mine)}`);
        const onList = recs.filter((r) => r.lists?.includes('neetcode150')).length;
        const offList = recs.find((r) => !r.lists?.length);

        // A failed records read: the error with Retry, no map; released, Retry recovers.
        const stage = ctx.page.getByRole('region', { name: 'Foundations' });
        const down = await ctx.intercept('listProblemRecords', { status: 500 });
        await ctx.ui.goto('/recruiting/progress');
        await ctx.ui.expectText('Couldn’t load your progress.');
        if (await stage.count()) fail('the map rendered over a failed read');
        await ctx.shot('progress-load-error');
        await down.release();
        await ctx.page.getByRole('button', { name: 'Retry' }).click();
        await stage.waitFor();

        // The map: five stages, 18 cards, the server's count.
        await ctx.ui.expectText(`${150 - onList} not tried`);
        const cards = ctx.page.locator('button[data-pattern]');
        if ((await cards.count()) !== PATTERN_COUNT)
          fail(`${await cards.count()} pattern cards, want ${PATTERN_COUNT}`);
        await ctx.page.setViewportSize(DESKTOP);
        try {
          // The pick's card opens its problems; the panel survives a reload; Close returns focus to the card.
          const card = ctx.page.locator(`button[data-pattern="${pick.pattern}"]`);
          await card.click();
          const panel = ctx.page.getByRole('region', { name: `${pick.patternName} problems` });
          const row = () => panel.getByRole('row').filter({ hasText: pick.title });
          await row().getByText('Solved before', { exact: true }).waitFor();
          await ctx.ui.settle();
          await ctx.shot('progress-map-open');
          await ctx.ui.goto(`/recruiting/progress?open=${pick.pattern}`);
          await row().getByText('Solved before', { exact: true }).waitFor();
          // Left only: the pick is gone from the open pattern's list, every row left untried.
          await ctx.page.getByRole('button', { name: 'Left only' }).click();
          // The panel re-renders from the URL: wait for the history-only row to go, then check what's left.
          await row()
            .waitFor({ state: 'hidden', timeout: 10_000 })
            .catch(() => fail('Left only still lists the history-only problem'));
          if (!(await panel.getByRole('row').count())) fail('Left only lists nothing');
          await ctx.shot('progress-left-only');
          await ctx.page.getByRole('button', { name: 'Left only' }).click();
          await panel.getByRole('button', { name: 'Close' }).click();
          await panel.waitFor({ state: 'hidden' });
          const focused = await ctx.page.evaluate<string | null>(
            '(() => document.activeElement?.getAttribute("data-pattern") ?? null)()',
          );
          if (focused !== pick.pattern) fail(`Close left focus on ${focused}`);
          // Off the list: this run's synthetic slug, outside the 150.
          if (offList) {
            await ctx.page.locator('details > summary').click();
            await ctx.ui.expectText(offList.title);
          } else fail('no off-list record: this run’s logged synthetic problem is missing');

          // Solves: newest first; Solved before narrows to the pick; a reload keeps it; no match, then Clear.
          await ctx.ui.goto('/recruiting/progress?view=solves');
          const table = ctx.page.getByRole('table', { name: 'Your solves' });
          await table.waitFor();
          const newest = [...recs].sort(
            (a, b) => b.lastDay.localeCompare(a.lastDay) || a.title.localeCompare(b.title),
          )[0]!;
          const first = await table.getByRole('link').first().textContent();
          if (first !== newest.title) fail(`Solves starts with "${first}", want "${newest.title}"`);
          await ctx.page
            .getByRole('combobox', { name: 'Status' })
            .selectOption({ label: 'Solved before' });
          await table.getByRole('link', { name: pick.title }).waitFor();
          await ctx.page.reload();
          await table.getByRole('link', { name: pick.title }).waitFor();
          if ((await ctx.page.getByRole('combobox', { name: 'Status' }).inputValue()) !== 'earlier')
            fail('the status filter didn’t survive a reload');
          await ctx.shot('progress-solves');
          await ctx.page
            .getByRole('combobox', { name: 'Difficulty' })
            .selectOption({ label: 'Easy' });
          await ctx.ui.expectText('Nothing matches these filters.');
          await ctx.page.getByRole('button', { name: 'Clear filters' }).click();
          await table.waitFor();
          if (new URL(ctx.page.url()).search !== '?view=solves')
            fail(`Clear filters left ${new URL(ctx.page.url()).search}`);

          // The problem's page from a filtered row; back keeps the filters.
          await ctx.page
            .getByRole('combobox', { name: 'Status' })
            .selectOption({ label: 'Solved before' });
          await table.getByRole('link', { name: pick.title }).click();
          await ctx.page.getByRole('heading', { name: pick.title }).waitFor();
          await ctx.ui.expectText(`Note: ${note}`);
          await ctx.ui.expectText(/history only/);
          await ctx.shot('progress-problem');
          await ctx.page.getByRole('link', { name: '← Progress' }).click();
          await table.waitFor();
          if (!new URL(ctx.page.url()).search.includes('status=earlier'))
            fail('← Progress dropped the filters');
          // A live logged try's minutes and note: this run's 'paper' attempt (15 min).
          await ctx.ui.goto(`/recruiting/progress/${slugOf(ctx, 'paper')}`);
          await ctx.ui.expectText('15 min');
          await ctx.ui.expectText(`Note: devcheck ${ctx.nonce}`);

          // Trends: the four cards.
          await ctx.ui.goto('/recruiting/progress?view=trends');
          for (const h of [
            'Problems a week',
            'First tries that were clean',
            'Re-solves that were clean',
          ])
            await ctx.page.getByRole('heading', { name: h }).waitFor();
          await ctx.page.getByRole('heading', { name: /^Time against the \d+ min cap$/ }).waitFor();
          await ctx.ui.settle();
          await ctx.shot('progress-trends');

          // The wider tab never scrolls sideways at 1512 and 1024.
          for (const size of [DESKTOP, { width: 1024, height: 768 }]) {
            await ctx.page.setViewportSize(size);
            for (const path of [
              `/recruiting/progress?open=${pick.pattern}`,
              '/recruiting/progress?view=solves',
              '/recruiting/progress?view=trends',
            ]) {
              await ctx.ui.goto(path);
              await ctx.ui.settle();
              const wide = await ctx.page.evaluate<boolean>(
                '(() => document.documentElement.scrollWidth > window.innerWidth)()',
              );
              if (wide) fail(`${path} scrolls sideways at ${size.width}`);
            }
          }
          await ctx.shot('progress-1024');
        } finally {
          await ctx.page.setViewportSize(PHONE);
        }

        // 390 px: the map with a card open, Solves and Trends, light then dark, never sideways.
        await ctx.page.setViewportSize({ width: 390, height: 844 });
        try {
          for (const path of [
            `/recruiting/progress?open=${pick.pattern}`,
            '/recruiting/progress?view=solves',
            '/recruiting/progress?view=trends',
          ]) {
            await ctx.ui.goto(path);
            await ctx.ui.settle();
            for (const theme of ['light', 'dark'] as const) {
              await ctx.ui.setTheme(theme);
              const wide = await ctx.page.evaluate<boolean>(
                '(() => document.documentElement.scrollWidth > window.innerWidth)()',
              );
              if (wide) fail(`${path}, ${theme}: the page scrolls sideways at 390`);
            }
          }
          await ctx.ui.goto(`/recruiting/progress?open=${pick.pattern}`);
          await ctx.ui.settle();
          await ctx.shot('progress-390');
        } catch (err) {
          await ctx.shot('progress-fail-at-390').catch(() => null);
          throw err;
        } finally {
          await ctx.ui.setTheme('light');
          await ctx.page.setViewportSize(PHONE);
        }

        // Premium in Settings: off, then on, each surviving a reload. On is the default and is restored.
        try {
          const box = () => ctx.page.getByRole('checkbox', { name: /I have LeetCode Premium/ });
          await ctx.ui.goto('/settings');
          if (!(await box().isChecked())) fail('LeetCode Premium starts off');
          await box().click();
          for (let i = 0; (await ctx.api.reads.getSettings()).leetcodePremium !== false; i++)
            if (i > 20) fail('LeetCode Premium off never saved');
            else await new Promise((r) => setTimeout(r, 250));
          await ctx.page.reload();
          if (await box().isChecked()) fail('LeetCode Premium off didn’t survive a reload');
          await ctx.shot('premium-off');
          // Off, no unseen pick is a Premium problem: no new or stretch slot, no alternative. (A Premium problem
          // already tried may still come back as a re-solve.)
          const off = await ctx.api.reads.getCoachToday();
          const offered = off.slots.flatMap((x) => [
            ...(x.kind === 'new' || x.kind === 'stretch' ? [x.slug] : []),
            ...(x.alternatives ?? []).map((a) => a.slug),
          ]);
          const hit = offered.filter((x) => PREMIUM_SLUGS.includes(x));
          if (hit.length) fail(`Premium off, yet the plan offers ${hit.join(', ')}`);
          await box().click();
          for (let i = 0; (await ctx.api.reads.getSettings()).leetcodePremium !== true; i++)
            if (i > 20) fail('LeetCode Premium on never saved');
            else await new Promise((r) => setTimeout(r, 250));
          await ctx.page.reload();
          if (!(await box().isChecked())) fail('LeetCode Premium on didn’t survive a reload');
        } finally {
          await ctx.api.writes.updateSettings({ leetcodePremium: true });
        }
      },
    },
    {
      id: 'progress-undo',
      title:
        'A history-only solve on a problem with a live try; then delete_attempt on both history-only ids',
      entry: 'mcp',
      proves: ['progress-mixed', 'progress-history-delete'],
      async run(ctx) {
        const { pick, id } = progressState();
        // The mixed branch: a history-only solve on this run's logged problem, which has a live try today.
        const paper = slugOf(ctx, 'paper');
        const liveBefore =
          (await ctx.api.reads.listProblemRecords()).find((r) => r.slug === paper && r.schedule) ??
          fail(`no live record with a schedule on ${paper}`);
        const mixed = await ctx.mcp.writes.logAttempt([
          { slug: paper, outcome: 'failed', historical: true, day: addDays(today(), -400) },
        ]);
        const paperId =
          mixed.attempts[0]?.id ?? fail('the mixed history-only solve stored nothing');
        const both = await ctx.mcp.reads.getProblem({ slug: paper });
        const flags = (both.tries ?? []).map((t) => `${t.historical === true}:${t.outcome}`);
        if (flags[0] !== 'true:failed' || flags.slice(1).some((f) => f.startsWith('true')))
          fail(`get_problem's tries, oldest first: ${flags.join(', ')}`);
        const liveAfter = (await ctx.api.reads.listProblemRecords()).find((r) => r.slug === paper);
        if (JSON.stringify(liveAfter?.schedule) !== JSON.stringify(liveBefore.schedule))
          fail(
            `the live schedule moved: ${JSON.stringify([liveBefore.schedule, liveAfter?.schedule])}`,
          );
        const gone = await ctx.mcp.writes.deleteAttempt(id);
        if (!gone.deleted) fail(`delete_attempt on the history-only id: ${JSON.stringify(gone)}`);
        if (!(await ctx.mcp.writes.deleteAttempt(paperId)).deleted)
          fail('delete_attempt on the mixed history-only id deleted nothing');
        if ((await ctx.api.reads.listProblemRecords()).some((r) => r.slug === pick.slug))
          fail('the history-only problem still has a record after delete_attempt');
      },
    },
    {
      id: 'b-draft-cause',
      title: 'A sitting with a failed submit; the review draft answers its lines and a cause',
      entry: 'api',
      cost: 'slow',
      proves: ['draft-cause'],
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({
          name: titleOf(ctx, 'draft-roll'),
          estimateMin: 45,
        });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        try {
          const { sitting } = await ctx.api.writes.lcSittingStart(
            start(slugOf(ctx, 'draft'), titleOf(ctx, 'draft')),
          );
          await ctx.api.writes.lcSittingEvents(sitting.id, [
            {
              id: devUlid(),
              type: 'submit',
              at: Date.now(),
              payload: {
                request: { lang: 'python3', typed_code: 'def f(a):\n    return a[0]' },
                result: {
                  status_code: 15,
                  status_msg: 'Runtime Error',
                  runtime_error: 'IndexError: list index out of range',
                  last_testcase: '[]',
                  expected_output: '0',
                  total_correct: 2,
                  total_testcases: 3,
                },
              },
            },
          ]);
          await finish(ctx, sitting.id, sitting.repTaskId, false);
          let out = await ctx.api.reads.draftSittingReview(sitting.id);
          // An outage isn't this feature's bug — one more try; a second failure is the row's.
          if (!out.ok && ['timeout', 'network', 'api'].includes(out.reason)) {
            ctx.log(`the real draft failed once (${out.reason}); one more try`);
            out = await ctx.api.reads.draftSittingReview(sitting.id);
          }
          const draft = out.ok ? out : fail(`draft failed: ${out.reason}`);
          if (!('cause' in draft)) fail('the draft has no cause field');
          const tags = ['no-trace', 'api-slip', 'boundary', 'off-by-one', 'quit-early'];
          if (draft.cause !== null && !tags.includes(draft.cause ?? ''))
            fail(`draft cause: ${String(draft.cause)}`);
          ctx.log(`draft cause: ${String(draft.cause)}; ${draft.mistakes.length} line(s)`);
          const after = await ctx.api.reads.getSitting(sitting.id);
          if (after.sitting.review) fail('the draft wrote a review');
        } finally {
          await ctx.api.writes.linkLeetcodeRoll(null);
        }
      },
    },
    {
      id: 'ui-draft-cause',
      title: 'The review form: a draft’s cause is marked, not picked; saved only once tapped',
      entry: 'ui',
      proves: ['ui-draft-cause'],
      async run(ctx) {
        const id = app.reviewId || fail('no review sitting — the ui-review step failed');
        await ctx.ui.goto(`/recruiting/sittings/${id}`);
        const p = ctx.page;
        const chip = (name: string) => p.getByRole('button', { name, exact: true });
        await chip('Boundary').waitFor({ timeout: 15_000 });
        // The model can't be told what to say: the draft's reply is the harness's (b-draft-cause proves the real one).
        const canned = await ctx.intercept('draftSittingReview', {
          status: 200,
          times: 1,
          body: { ok: true, mistakes: ['devcheck draft line'], cause: 'off-by-one' },
        });
        await p.getByRole('button', { name: 'Draft with Claude' }).click();
        await ctx.ui.expectText('Claude suggests Off by one — tap it to use it.', 10_000);
        await canned.release();
        if ((await chip('Off by one').getAttribute('aria-pressed')) !== 'false')
          fail('the draft’s cause was picked for them');
        if ((await chip('Boundary').getAttribute('aria-pressed')) !== 'true')
          fail('the draft moved the saved cause');
        await ctx.shot('lc-coach-draft-cause');
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        // getSitting is a consistent read: a stale list can't answer the old cause over a wrong write.
        const causeNow = async () =>
          ((await ctx.api.reads.getSitting(id)).sitting.review as { cause?: string } | null)?.cause;
        const first = await causeNow();
        if (first !== 'boundary') fail(`an untapped proposal was saved: ${String(first)}`);
        const again = await ctx.intercept('draftSittingReview', {
          status: 200,
          times: 1,
          body: { ok: true, mistakes: ['devcheck draft line'], cause: 'off-by-one' },
        });
        await p.getByRole('button', { name: 'Draft with Claude' }).click();
        await ctx.ui.expectText('Claude suggests Off by one — tap it to use it.', 10_000);
        await again.release();
        await chip('Off by one').click();
        await p.getByRole('button', { name: 'Save review' }).click();
        await ctx.ui.expectText('Saved.', 15_000);
        // "Saved." may still be the first Save's line for a moment: wait for the second to land.
        let tapped = await causeNow();
        for (let i = 0; i < 40 && tapped !== 'off-by-one'; i++) {
          await new Promise((r) => setTimeout(r, 250));
          tapped = await causeNow();
        }
        if (tapped !== 'off-by-one') fail(`the tapped cause: ${String(tapped)}`);
      },
    },
    // --- PR E: mock interviews. Labelled with the run's tag, so a leftover from another run is never read. ---
    {
      id: 'mocks-ui',
      title:
        'Mocks on the Today card: refused without Code, logged with scores, one planned for tomorrow; Patterns; 390 px',
      entry: 'ui',
      proves: [
        'mock-ui-invalid',
        'mock-ui-log',
        'mock-slots-unchanged',
        'mock-ui-plan',
        'mock-ui-log-planned',
        'mock-patterns',
        'mock-patterns-delete',
        'mock-ui-unlogged',
        'mock-390',
        'mock-ui-cancel-focus',
        'mock-ui-cancel-5xx',
      ],
      async run(ctx) {
        const label = `dc ${tag(ctx)}`.slice(0, 40);
        const mine = async (status: DevMock['status']) =>
          (await ctx.api.reads.listMocks()).filter(
            (m) => m.partner === label && m.status === status,
          );
        const before = await ctx.api.reads.getCoachToday();
        let c = await todayCard(ctx);
        const block = c.getByRole('region', { name: 'Mock interviews' });
        await block.getByRole('button', { name: 'Log a mock' }).click();
        let form = block.getByRole('form', { name: 'Log a mock' });
        await form.getByRole('button', { name: 'Solve 2 of 4' }).click();
        await form.getByLabel('Who ran it (optional)').fill(label);
        await form.getByRole('button', { name: 'Save mock' }).click();
        await form
          .getByRole('alert')
          .getByText(/Code and Solve/)
          .waitFor({ timeout: 5_000 });
        if ((await form.getByLabel('Who ran it (optional)').inputValue()) !== label)
          fail('the refused form lost what was typed');
        if ((await mine('done')).length) fail('a done mock with no Code was saved');
        await ctx.shot('lc-coach-mock-refused');

        // 390 px, light then dark, with the form open: the score buttons on screen, no sideways scroll.
        await ctx.page.setViewportSize({ width: 390, height: 844 });
        try {
          for (const theme of ['light', 'dark'] as const) {
            await ctx.ui.setTheme(theme);
            const wide = await ctx.page.evaluate<boolean>(
              '(() => document.documentElement.scrollWidth > window.innerWidth)()',
            );
            if (wide) fail(`${theme}: the page scrolls sideways at 390 with the mock form open`);
            const four = form.getByRole('button', { name: 'Communication 4 of 4' });
            await four.scrollIntoViewIfNeeded();
            const box = await four.boundingBox();
            if (!box || box.x < 0 || box.x + box.width > 390)
              fail(`${theme}: the score buttons run off screen at 390`);
            await ctx.ui.settle();
            await ctx.shot(`lc-coach-mock-form-390-${theme}`);
          }
        } finally {
          await ctx.ui.setTheme('light');
          await ctx.page.setViewportSize(PHONE);
        }

        await form.getByRole('button', { name: 'Code 3 of 4' }).click();
        await form.getByRole('button', { name: 'Save mock' }).click();
        await block
          .getByText('Mock this week: Code 3 · Solve 2', { exact: true })
          .waitFor({ timeout: 15_000 });
        const [done] = await mine('done');
        if (!done || done.day !== before.day || done.scores?.code !== 3 || done.scores.solve !== 2)
          fail(`the logged mock: ${JSON.stringify(done)}`);
        await ctx.shot('lc-coach-mock-logged');

        // Plan one for tomorrow: it joins the next 48 hours.
        await block.getByRole('button', { name: 'Log a mock' }).click();
        form = block.getByRole('form', { name: 'Log a mock' });
        await form.getByRole('button', { name: 'Planned' }).click();
        await form.getByLabel('Day').fill(addDays(before.day, 1));
        await form.getByLabel('Who ran it (optional)').fill(label);
        await form.getByRole('button', { name: 'Plan mock' }).click();
        const row = () =>
          c
            .getByRole('region', { name: 'Next 48 hours' })
            .getByRole('listitem')
            .filter({ hasText: `with ${label}` });
        await row().waitFor({ timeout: 15_000 });
        if (!((await row().textContent()) ?? '').includes('tomorrow'))
          fail(`the planned row reads “${await row().textContent()}”`);
        const [planned] = await mine('planned');
        if (planned?.day !== addDays(before.day, 1))
          fail(`the planned mock: ${JSON.stringify(planned)}`);
        await ctx.shot('lc-coach-mock-planned');

        // One planned for today, then Log it on its row: the same id, now done.
        await block.getByRole('button', { name: 'Log a mock' }).click();
        form = block.getByRole('form', { name: 'Log a mock' });
        await form.getByRole('button', { name: 'Planned' }).click();
        await form.getByLabel('Day').fill(before.day);
        await form.getByLabel('Who ran it (optional)').fill(label);
        await form.getByLabel('Notes (optional)').fill(`planned ${ctx.nonce}`);
        await form.getByRole('button', { name: 'Plan mock' }).click();
        const todayRow = c
          .getByRole('region', { name: 'Next 48 hours' })
          .getByRole('listitem')
          .filter({ hasText: `with ${label}` })
          .filter({ hasText: 'today' });
        await todayRow.getByRole('button', { name: /^Log it — mock today/ }).click();
        form = block.getByRole('form', { name: 'Log the planned mock' });
        await form.getByRole('button', { name: 'Code 4 of 4' }).click();
        await form.getByRole('button', { name: 'Solve 3 of 4' }).click();
        await form.getByRole('button', { name: 'Save mock' }).click();
        await todayRow.waitFor({ state: 'hidden', timeout: 15_000 });
        const plannedToday = (await ctx.api.reads.listMocks()).filter(
          (m) => m.partner === label && m.notes === `planned ${ctx.nonce}`,
        );
        if (
          plannedToday.length !== 1 ||
          plannedToday[0]!.status !== 'done' ||
          plannedToday[0]!.scores?.code !== 4
        )
          fail(`Log it: ${JSON.stringify(plannedToday)}`);
        const loggedId = plannedToday[0]!.id;

        const after = await ctx.api.reads.getCoachToday();
        if (!same(slugs(after), slugs(before)))
          fail(`a mock moved the slots: ${slugs(before).join(',')} → ${slugs(after).join(',')}`);

        // Patterns: the done one, its scores beside its week's first tries.
        await ctx.ui.goto('/recruiting/patterns');
        const item = ctx.page
          .getByRole('region', { name: 'Mock interviews' })
          .getByRole('listitem')
          .filter({ hasText: `with ${label}` })
          .filter({ hasText: 'Code 3 · Solve 2' }); // the Log it one is Code 4 · Solve 3
        await item.getByText('Code 3 · Solve 2', { exact: true }).waitFor({ timeout: 15_000 });
        await item
          .getByText(/^(First try that week \d+ of \d+( \(\d+%\))?|No first try that week)$/)
          .waitFor();
        await ctx.shot('lc-coach-mock-patterns');
        // Delete the logged-from-planned one there: asks once, Yes removes it.
        const gone = ctx.page
          .getByRole('region', { name: 'Mock interviews' })
          .getByRole('listitem')
          .filter({ hasText: 'Code 4 · Solve 3' })
          .filter({ hasText: `with ${label}` });
        await gone.getByRole('button', { name: /^Delete the mock on / }).click();
        await gone.getByRole('button', { name: /^Yes, delete the mock on / }).click();
        await until(
          'the deleted mock gone',
          async () => !(await ctx.api.reads.listMocks()).some((m) => m.id === loggedId),
        );

        // Cancel the planned one from the card.
        c = await todayCard(ctx);
        await row()
          .getByRole('button', { name: /^Cancel — mock tomorrow/ })
          .click();
        await until('the planned mock gone', async () => !(await mine('planned')).length);
        await focusOn(ctx, 'Log a mock', 'after Cancel');

        // A Cancel that lands but answers 500: the cache, not the answer, says it went.
        const late = `${label} 5`.slice(0, 40);
        await ctx.mcp.writes.logMock({
          status: 'planned',
          day: addDays(before.day, 1),
          partner: late,
        });
        c = await todayCard(ctx);
        const lateRow = c
          .getByRole('region', { name: 'Next 48 hours' })
          .getByRole('listitem')
          .filter({ hasText: `with ${late}` });
        await lateRow.waitFor({ timeout: 15_000 });
        const answer500 = await ctx.intercept('deleteMock', {
          status: 500,
          times: 1,
          forward: true,
        });
        try {
          await lateRow.getByRole('button', { name: /^Cancel — mock tomorrow/ }).click();
          await lateRow.waitFor({ state: 'hidden', timeout: 15_000 });
          if (answer500.hits() !== 1) fail(`the 500 answered ${answer500.hits()} cancels`);
        } finally {
          await answer500.release();
        }
        if ((await ctx.api.reads.listMocks()).some((m) => m.partner === late))
          fail('the forwarded cancel didn’t land');
        await focusOn(ctx, 'Log a mock', 'after a Cancel answered 500');
        if (await block.getByRole('alert').count())
          fail(`a landed cancel shows “${await block.getByRole('alert').textContent()}”`);
        const said = (await block.getByRole('status').textContent())?.trim();
        if (said !== 'Mock cancelled.') fail(`the section’s status line reads “${said}”`);
        await ctx.shot('lc-coach-mock-cancel-500');

        // One planned for yesterday (over MCP: the form can't plan a past day) waits under the line; Cancel there.
        const past = `${label} p`.slice(0, 40);
        await ctx.mcp.writes.logMock({
          status: 'planned',
          day: addDays(before.day, -1),
          partner: past,
        });
        c = await todayCard(ctx);
        const waiting = c
          .getByRole('list', { name: 'Planned mocks not logged yet' })
          .getByRole('listitem')
          .filter({ hasText: `with ${past}` });
        await waiting.waitFor({ timeout: 15_000 });
        if (!(await waiting.getByRole('button', { name: /^Log it — mock yesterday/ }).count()))
          fail('a passed planned mock offers no Log it');
        await ctx.shot('lc-coach-mock-unlogged');
        await waiting.getByRole('button', { name: /^Cancel — mock yesterday/ }).click();
        await until(
          'the passed planned mock gone',
          async () => !(await ctx.api.reads.listMocks()).some((m) => m.partner === past),
        );
        await row().waitFor({ state: 'hidden', timeout: 15_000 });
      },
    },
    {
      id: 'mocks-mcp',
      title: 'log_mock refuses a bad score, then logs one; list_mocks reads it back',
      entry: 'mcp',
      proves: ['mock-mcp', 'mock-mcp-invalid'],
      async run(ctx) {
        const label = `dc mcp ${tag(ctx)}`.slice(0, 40);
        const count = async () => (await ctx.api.reads.listMocks()).length;
        const n0 = await count();
        const refusal = /scores\.code is required, a whole number from 1 to 4/; // normalizeMock's
        for (const [scores, why] of [
          [{ code: 5, solve: 2 }, refusal],
          [{ solve: 2 }, refusal],
        ] as const) {
          let took = false;
          try {
            await ctx.mcp.writes.logMock({ scores, partner: label });
            took = true;
          } catch (err) {
            if (!why.test(String(err))) throw err;
          }
          if (took) fail(`log_mock took ${JSON.stringify(scores)}`);
        }
        if ((await count()) !== n0) fail('a refused log_mock wrote a mock');
        const out = await ctx.mcp.writes.logMock({
          scores: { code: 2, solve: 3 },
          kind: 'claude',
          partner: label,
          notes: `devcheck ${ctx.nonce}`,
        });
        if (out.week === null) fail('log_mock saved, but its read of the week failed');
        if (
          out.mock.status !== 'done' ||
          out.mock.scores?.solve !== 3 ||
          !out.week!.startsWith('Mock this week')
        )
          fail(`log_mock: ${JSON.stringify(out)}`);
        const list = await ctx.mcp.reads.listMocks({ from: today() });
        const hit = list.mocks.find((m) => m.id === out.mock.id);
        if (!hit || hit.partner !== label || hit.kind !== 'claude')
          fail(`list_mocks: ${JSON.stringify(list.mocks)}`);
        if (!list.trend.some((x) => x.code === 2 && x.solve === 3))
          fail('list_mocks’ trend lacks it');
        const t = await ctx.mcp.reads.leetcodeToday();
        if (t.mock?.thisWeek !== 'done') fail(`leetcode_today’s mock: ${JSON.stringify(t.mock)}`);
      },
    },
    {
      id: 'mocks-delete',
      title: 'deleteMock twice on the MCP step’s mock: the second is a no-op',
      entry: 'api',
      proves: ['mock-delete-idempotent'],
      async run(ctx) {
        const label = `dc mcp ${tag(ctx)}`.slice(0, 40);
        const m =
          (await ctx.api.reads.listMocks()).find((x) => x.partner === label) ??
          fail('no mock from the mcp step to delete');
        await ctx.api.writes.deleteMock(m.id);
        await ctx.api.writes.deleteMock(m.id);
        if ((await ctx.api.reads.listMocks()).some((x) => x.id === m.id))
          fail('the mock is still listed after two deletes');
      },
    },
    noConsoleErrors,
  ],
};

// The app steps' own state: the sittings ui-review and ui-f169 saved.
const app = { reviewId: '', f169Id: '' };
// recruitingHelpers.ts dueBeyondSlots: due re-solves not already a live (unskipped) slot.
const dueBeyond = (t: DevCoachToday) =>
  t.due.filter((q) => !t.slots.some((x) => x.status !== 'skipped' && x.slug === q.slug));
export async function todayCard(ctx: Ctx) {
  await ctx.ui.goto('/recruiting');
  const c = ctx.page.getByRole('region', { name: 'Today’s practice' });
  await c
    .getByText(/ · day \d of 3/)
    .first()
    .waitFor({ timeout: 15_000 });
  return c;
}
export async function morning(ctx: Ctx) {
  await ctx.ui.goto('/');
  await ctx.page.getByRole('button', { name: 'Morning', exact: true }).click();
  await ctx.page.getByText('Plan today', { exact: true }).waitFor({ timeout: 15_000 });
}
// Keyboard focus on a control whose accessible name ends with `name`, or matches it (a slot's buttons end
// "— <title>"), never <body>: the card's focus-return (CONVENTIONS → focus-return).
async function focusOn(ctx: Ctx, name: string | RegExp, when: string) {
  const at = () =>
    ctx.page.evaluate<string | null>(
      '(() => { const a = document.activeElement; return !a || a === document.body ? null : (a.getAttribute("aria-label") ?? a.textContent ?? "").trim(); })()',
    );
  const on = async () => {
    const got = await at();
    return !!got && (typeof name === 'string' ? got.endsWith(name) : name.test(got));
  };
  await until(`focus on “${name}” ${when}`, on, 5_000).catch(async (e: Error) =>
    fail(`${e.message} — it is on ${JSON.stringify(await at())}`),
  );
}
// An open slot's first button: never the pressed Restore, whose label ends in the same title.
const openButton = (title: string) => {
  const literal = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(Another problem|Skip today) — ${literal}$`);
};
export async function until(what: string, ok: () => Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500)))
    if (await ok()) return;
  fail(`timed out waiting for ${what}`);
}
