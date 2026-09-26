// Seed dataset for the stub — a few backdated weeks so the calibration and night-review surfaces
// have something honest to render. Without this, page-first validation would judge every data view
// against an empty store. Values are index-derived (not random) so the seed is reproducible.

import { addDays, dayKey, rollRepFields } from '@aperture/shared';
import type {
  BaseEntity,
  Category,
  CompetencyTag,
  Habit,
  LeetcodeVerdict,
  PomodoroSession,
  Roll,
  Task,
} from '@aperture/shared';
import type { Store } from './stubClient';

const USER_ID = 'local';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const START_HOUR = 4;

export function seedStore(store: Store, nowMs: number, ulid: () => string): void {
  const mk = (createdAt: number): BaseEntity => ({
    id: ulid(),
    userId: USER_ID,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });

  // Categories — the starting set (deep work · admin · learning · health · people).
  const catDefs = [
    { label: 'Deep Work', isWork: true },
    { label: 'Admin', isWork: true },
    { label: 'Learning', isWork: true },
    { label: 'Health', isWork: false },
    { label: 'People', isWork: false },
  ];
  const cats: Category[] = catDefs.map((c, i) => ({
    ...mk(nowMs - 30 * DAY),
    label: c.label,
    isWork: c.isWork,
    order: i,
    active: true,
  }));
  store.categories.push(...cats);
  const byLabel = (l: string) => cats.find((c) => c.label === l)!;

  // Two seeded Google accounts so dev opens in the connected state (shape panel, pickers, add-to-cal all
  // exercisable); placeholder emails, never real PII. Disconnect one in Settings to see the empty state.
  store.settings = {
    ...mk(nowMs - 30 * DAY),
    dayStartHour: START_HOUR,
    pomodoroWorkMin: 25,
    pomodoroBreakMin: 5,
    theme: 'auto',
    googleAccounts: [
      { sub: 'seed-personal', email: 'you@gmail.com' },
      { sub: 'seed-school', email: 'you@school.edu' },
    ],
    calendarShapeRefs: [
      { accountSub: 'seed-personal', calendarId: 'you@gmail.com' },
      { accountSub: 'seed-school', calendarId: 'you@school.edu' },
    ],
    calendarWriteDefault: { accountSub: 'seed-personal', calendarId: 'you@gmail.com' },
    dayFocusStart: 8,
    dayEndHour: 22,
  };

  const estimates = [30, 45, 60, 90];
  const factors = [0.8, 1.1, 1.3, 1.6]; // mostly > 1 → the honest "I underestimate" bias
  const workCats = ['Deep Work', 'Admin', 'Learning'];
  // Real-shaped titles: the calibration list is a column of task names, and "Task from 2026-08-04"
  // seven times over makes the signature surface read as filler rather than as your own week.
  const doneTitles = [
    'Write the migration plan',
    'Review the PR backlog',
    'Debug the auth redirect',
    'Draft standup notes',
    'Refactor the query layer',
    'Read the design doc',
    'Fix the failing snapshot test',
  ];
  const snippets = [
    'Shipped the thing I was dreading. Easier than the dread.',
    'Long meeting; low focus after.',
    'Good gym session, cleared my head.',
    'Read a chapter before bed.',
    'Called home — overdue.',
    'Stuck on a bug for an hour, stepped away, fixed it in five.',
    'Planned tomorrow: fewer things, bigger things.',
  ];

  for (let d = 13; d >= 0; d--) {
    const t = nowMs - d * DAY - 3 * HOUR; // roughly the same time of day, d days ago
    const day = dayKey(t, START_HOUR);

    store.logEntries.push({ ...mk(t), day, text: snippets[d % snippets.length]! });
    if (d % 3 === 0) {
      store.logEntries.push({
        ...mk(t - 4 * HOUR),
        day,
        text: snippets[(d + 2) % snippets.length]!,
      });
    }

    if (d % 2 === 0) {
      const i = (d / 2) % estimates.length;
      const est = estimates[i]!;
      const actual = Math.round(est * factors[i]!);
      const cat = byLabel(workCats[(d / 2) % workCats.length]!);
      const completedAt = t;
      const startedAt = completedAt - actual * 60_000;
      const task: Task = {
        ...mk(startedAt),
        title: doneTitles[(d / 2) % doneTitles.length]!,
        status: 'done',
        categoryId: cat.id,
        dueDay: null,
        notes: null,
        seriesId: null,
        rollId: null,
        estimateMin: est,
        bufferMin: Math.round(est * 0.25),
        estimateLockedMin: est,
        actualAccruedMin: actual,
        startedAt,
        completedAt,
        cancelledAt: null,
        gcalAccountId: null,
        gcalCalendarId: null,
        gcalEventId: null,
      };
      store.tasks.push(task);
      const session: PomodoroSession = {
        ...mk(startedAt),
        taskId: task.id,
        categoryId: cat.id,
        label: null,
        wasWork: cat.isWork,
        kind: 'work',
        startedAt,
        endedAt: completedAt,
        day,
        activeMinutes: actual,
        status: 'completed',
        lastHeartbeatAt: completedAt,
      };
      store.sessions.push(session);
    }
  }

  // A handful of unscoped backlog tasks — captured title-only, waiting for the morning plan pass.
  // These make the morning "plan today" card real and give Phase 5 material to scope.
  const today = dayKey(nowMs, START_HOUR);
  // Mixed due days so the morning pull's soonest-due sort and the relative phrasing are both visible
  // on first load: a couple dated (one overdue, one far out), the rest undated.
  // Two carry notes, so the rendered markdown and the row's notes marker show on first load.
  const backlogSeeds: { title: string; dueOffset: number | null; notes?: string }[] = [
    {
      title: 'Draft the project proposal',
      dueOffset: 2,
      notes:
        'Aim for **two pages**, and keep the scope *honest*.\n\n- Problem + why now\n- Prior work (see [the brief](https://example.com/brief))\n- Timeline',
    },
    { title: 'Fix the flaky CI test', dueOffset: -1 },
    { title: 'Reply to advisor email', dueOffset: null },
    { title: 'Submit the lab report', dueOffset: 4 },
    { title: 'Prep for the quiz', dueOffset: 5 },
    { title: 'Outline the reading notes', dueOffset: 12 },
    { title: 'Book dentist appointment', dueOffset: null },
  ];
  backlogSeeds.forEach(({ title, dueOffset, notes }, i) => {
    store.tasks.push({
      ...mk(nowMs - (i + 1) * HOUR),
      title,
      status: 'backlog',
      categoryId: null,
      dueDay: dueOffset === null ? null : addDays(today, dueOffset),
      notes: notes ?? null,
      seriesId: null,
      rollId: null,
      estimateMin: null,
      bufferMin: null,
      estimateLockedMin: null,
      actualAccruedMin: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
    });
  });

  // Today's plan — a few tasks pulled in and ordered, so the daytime "Right now" hero + Big 3 render
  // on first load. The 2nd is in progress (the hero to glance); the rest are ready to start, and the
  // tail spills into "Also today" (where "Focus this" is exercisable).
  const planSeeds: {
    title: string;
    cat: string;
    est: number;
    inProgress?: boolean;
    notes?: string;
  }[] = [
    {
      title: 'Finish the problem set',
      cat: 'Deep Work',
      est: 60,
      notes:
        'Ch. 4, q1–8. Office hours Thu.\n\n1. q1–5 are warm-ups\n2. q6: use the `lemma` from lecture\n3. q8 is the long one\n\nhttps://example.edu/pset4',
    },
    { title: 'Rewrite the onboarding section', cat: 'Deep Work', est: 45, inProgress: true },
    { title: 'Clear the email backlog', cat: 'Admin', est: 20 },
    { title: 'Skim the lecture notes', cat: 'Learning', est: 30 },
    { title: 'Tidy the desk', cat: 'Admin', est: 10 },
  ];
  planSeeds.forEach(({ title, cat, est, inProgress, notes }, i) => {
    const at = nowMs - (i + 1) * 30 * 60_000;
    const task: Task = {
      ...mk(at),
      title,
      status: inProgress ? 'in_progress' : 'planned',
      categoryId: byLabel(cat).id,
      dueDay: null,
      notes: notes ?? null,
      seriesId: null,
      rollId: null,
      estimateMin: est,
      bufferMin: Math.round(est * 0.25),
      estimateLockedMin: inProgress ? est : null,
      actualAccruedMin: inProgress ? 12 : 0,
      startedAt: inProgress ? nowMs - 20 * 60_000 : null,
      completedAt: null,
      cancelledAt: null,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
    };
    store.tasks.push(task);
    store.plans.push({
      ...mk(at),
      taskId: task.id,
      day: today,
      plannedMinutes: est + Math.round(est * 0.25),
      order: i,
    });
  });

  const read: Habit = {
    ...mk(nowMs - 20 * DAY),
    name: 'Read 20 min',
    categoryId: byLabel('Learning').id,
    cadencePerWeek: 5,
    active: true,
  };
  const workout: Habit = {
    ...mk(nowMs - 20 * DAY),
    name: 'Workout',
    categoryId: byLabel('Health').id,
    cadencePerWeek: 3,
    active: true,
  };
  const call: Habit = {
    ...mk(nowMs - 20 * DAY),
    name: 'Call family',
    categoryId: byLabel('People').id,
    cadencePerWeek: 1,
    active: true,
  };
  store.habits.push(read, workout, call);

  const check = (habit: Habit, d: number) => {
    const t = nowMs - d * DAY - 3 * HOUR;
    store.habitChecks.push({ ...mk(t), habitId: habit.id, date: dayKey(t, START_HOUR) });
  };
  [1, 3, 5, 8, 10, 12].forEach((d) => check(read, d));
  [2, 5, 9, 12].forEach((d) => check(workout, d));
  check(call, 6);

  // --- Rolls — deadline-free ongoing efforts, with a backdated "contact sheet" of reps so the grid
  // isn't empty on first load. A rep is a done task tagged with the roll; momentum is DERIVED from these.
  const leetcode: Roll = {
    ...mk(nowMs - 25 * DAY),
    name: 'LeetCode daily',
    categoryId: byLabel('Learning').id,
    estimateMin: 30,
    active: true,
  };
  const study: Roll = {
    ...mk(nowMs - 25 * DAY),
    name: 'Study systems design',
    categoryId: byLabel('Learning').id,
    estimateMin: 45,
    active: true,
  };
  const build: Roll = {
    ...mk(nowMs - 25 * DAY),
    name: 'Work on Aperture',
    categoryId: byLabel('Deep Work').id,
    estimateMin: 60,
    active: true,
  };
  store.rolls.push(leetcode, study, build);

  // One done rep = one filled cell. `seq` offsets a second rep on the same day so a cell can read "2".
  const rep = (roll: Roll, dAgo: number, seq = 0) => {
    const completedAt = nowMs - dAgo * DAY - (2 + seq) * HOUR;
    const est = roll.estimateMin ?? 30;
    const actual = Math.round(est * factors[dAgo % factors.length]!);
    const startedAt = completedAt - actual * 60_000;
    store.tasks.push({
      ...mk(startedAt),
      title: roll.name,
      status: 'done',
      categoryId: roll.categoryId,
      dueDay: null,
      notes: null,
      seriesId: null,
      rollId: roll.id,
      estimateMin: est,
      bufferMin: null,
      estimateLockedMin: est,
      actualAccruedMin: actual,
      startedAt,
      completedAt,
      cancelledAt: null,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
    });
  };
  // Frequent-but-gappy for LeetCode (with two two-a-day cells), sparser for the others — a lived-in sheet.
  [1, 2, 4, 5, 6, 8, 9, 11, 13, 15, 16, 18, 20, 22, 23, 25, 27, 29, 31, 34].forEach((d) =>
    rep(leetcode, d),
  );
  [2, 6].forEach((d) => rep(leetcode, d, 1));
  [3, 7, 12, 17, 21, 28, 33].forEach((d) => rep(study, d));
  [4, 10, 18, 25, 32].forEach((d) => rep(build, d));

  // LeetCode already picked for today — a planned rep appended after the plan seeds, so it lands in the
  // daytime "Also today" lane (where completing it becomes today's rep). Built via the SAME shared helper
  // pickRollToday uses, so the seed can't drift from the real pick.
  const pickedAt = nowMs - 15 * 60_000;
  const pickedRep: Task = { ...mk(pickedAt), ...rollRepFields(leetcode) };
  store.tasks.push(pickedRep);
  store.plans.push({
    ...mk(pickedAt),
    taskId: pickedRep.id,
    day: today,
    plannedMinutes: leetcode.estimateMin ?? 30,
    order: planSeeds.length,
  });

  // LeetCode attempts — a few backdated, with wrong→accepted arcs so the derived attempt-count reads > 1.
  const lc = (
    dAgo: number,
    slug: string,
    title: string,
    verdict: LeetcodeVerdict,
    difficulty: string,
    topicTags: string[],
    subId: string,
  ) => {
    const t = nowMs - dAgo * DAY - 2 * HOUR;
    store.leetcodeAttempts.push({
      ...mk(t),
      day: dayKey(t, START_HOUR),
      problemSlug: slug,
      problemTitle: title,
      verdict,
      submittedAt: t,
      lang: 'python3',
      runtimeMs: verdict === 'accepted' ? 12 : null,
      memory: verdict === 'accepted' ? 20_800_000 : null,
      leetcodeSubmissionId: subId,
      frontendId: null,
      difficulty,
      topicTags,
    });
  };
  const TS = ['Array', 'Hash Table'];
  const SW = ['Hash Table', 'String', 'Sliding Window'];
  lc(5.02, 'two-sum', 'Two Sum', 'runtime_error', 'Easy', TS, 'seed-lc-1');
  lc(5, 'two-sum', 'Two Sum', 'accepted', 'Easy', TS, 'seed-lc-2');
  lc(
    3,
    'add-two-numbers',
    'Add Two Numbers',
    'accepted',
    'Medium',
    ['Linked List', 'Math'],
    'seed-lc-3',
  );
  const LS = 'longest-substring-without-repeating-characters';
  const LST = 'Longest Substring Without Repeating Characters';
  lc(1.02, LS, LST, 'wrong_answer', 'Medium', SW, 'seed-lc-4');
  lc(1, LS, LST, 'accepted', 'Medium', SW, 'seed-lc-5');

  // Story bank — a couple of STAR stories so page-first isn't judged against an empty bank. One is fully
  // written with two tags; the other is a single-tag stub with an empty result — the "start ugly, tighten
  // later" state the editor deliberately allows.
  const story = (
    dAgo: number,
    title: string,
    competencyTags: CompetencyTag[],
    situation: string,
    action: string,
    result: string,
  ) => {
    const t = nowMs - dAgo * DAY;
    store.stories.push({ ...mk(t), title, competencyTags, situation, action, result });
  };
  story(
    6,
    'Turned around the failing migration',
    ['ownership', 'leadership'],
    'Our data migration was three weeks behind and the team had lost confidence it would ever land.',
    'I broke it into daily verifiable slices, paired on the riskiest one, and ran a 10-minute daily check-in.',
    'We shipped in two weeks with zero rollbacks, and the check-in format stuck for later projects.',
  );
  story(
    2,
    'Disagreed with my lead on the rewrite',
    ['conflict'],
    'My lead wanted a full rewrite; I thought an incremental refactor was the safer bet.',
    '',
    '',
  );
}
