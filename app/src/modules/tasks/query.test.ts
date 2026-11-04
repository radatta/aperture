import { describe, expect, it } from 'vitest';
import type { Category, Task } from '@aperture/shared';
import {
  applyQuery,
  foldParts,
  groupTasks,
  inDueBucket,
  isNarrowing,
  LENS_PRESET,
  matchedInNotes,
  matchesText,
  normalize,
  overrideChips,
  placeOf,
  placer,
  resetToLens,
  sortTasks,
  type QueryCtx,
  type TaskQuery,
} from './query';

const TODAY = '2026-09-23'; // a Wednesday

const task = (over: Partial<Task>): Task => ({
  id: 't',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'x',
  status: 'backlog',
  categoryId: null,
  dueDay: null,
  dueTime: null,
  notes: null,
  seriesId: null,
  rollId: null,
  estimateMin: null,
  bufferMin: null,
  estimateLockedMin: null,
  parentId: null,
  place: null,
  actualAccruedMin: 0,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  gcalAccountId: null,
  gcalCalendarId: null,
  gcalEventId: null,
  gcalSyncError: null,
  ...over,
});

const cat = (id: string, label: string, order: number, active = true): Category => ({
  id,
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  label,
  isWork: true,
  order,
  active,
});

const CATS = [cat('c2', 'CSCI 187', 2), cat('c1', 'CSEN 146', 1), cat('hw', 'Homework', 0, false)];
const ctx = (planOrder: [string, number][] = []): QueryCtx => ({
  today: TODAY,
  planOrder: new Map(planOrder),
  categories: CATS,
  dayStartHour: 4,
});
const pctx = (planOrder = new Map<string, number>(), dayStartHour = 4) => ({
  today: TODAY,
  planOrder,
  dayStartHour,
});
const labelOf = (id: string | null) => CATS.find((c) => c.id === id)?.label ?? '';
const q = (
  over: Partial<TaskQuery> = {},
  lens: keyof typeof LENS_PRESET = 'backlog',
): TaskQuery => ({
  ...LENS_PRESET[lens],
  ...over,
});

describe('placeOf', () => {
  const none = new Map<string, number>();
  it.each([
    ['p1 done → done', task({ status: 'done' }), none, 'done'],
    ['p2 dropped → done', task({ status: 'cancelled' }), none, 'done'],
    [
      'p3 on today’s plan → today',
      task({ id: 'a', status: 'planned' }),
      new Map([['a', 0]]),
      'today',
    ],
    ['p4 in progress, unplanned → today', task({ status: 'in_progress' }), none, 'today'],
    ['p5 due today → week', task({ dueDay: TODAY }), none, 'week'],
    ['p6 due today+6 → week', task({ dueDay: '2026-09-29' }), none, 'week'],
    ['p7 due today+7 → backlog', task({ dueDay: '2026-09-30' }), none, 'backlog'],
    ['p8 past due → week', task({ dueDay: '2026-09-01' }), none, 'week'],
    ['p9 planned for another day, undated → backlog', task({ status: 'planned' }), none, 'backlog'],
    ['p10 an errand → places', task({ place: 'market' }), none, 'places'],
    ['p11 an errand due this week → week', task({ place: 'market', dueDay: TODAY }), none, 'week'],
    [
      'p12 an errand on today’s plan → today',
      task({ id: 'a', status: 'planned', place: 'market' }),
      new Map([['a', 0]]),
      'today',
    ],
    [
      'p13 an errand started → today',
      task({ status: 'in_progress', place: 'market' }),
      none,
      'today',
    ],
    ['p14 an errand done → done', task({ status: 'done', place: 'market' }), none, 'done'],
  ] as const)('%s', (_name, t, plan, want) => {
    expect(placeOf(t, pctx(plan as Map<string, number>))).toBe(want);
  });

  it('treats an empty-string dueDay as undated', () => {
    expect(placeOf(task({ dueDay: '' }), pctx())).toBe('backlog');
  });

  it('a part off today lives where its open parent does — its own time is when it ends', () => {
    const parent = task({ id: 'p', dueDay: '2026-09-25' });
    const part = task({ id: 'a', parentId: 'p', dueDay: '2026-10-20' });
    expect(placeOf(part, pctx(), parent)).toBe('week');
    expect(placeOf(part, pctx(new Map([['a', 0]])), parent)).toBe('today');
    expect(placeOf(part, pctx(), { ...parent, status: 'done' })).toBe('backlog'); // its own
    expect(placer([parent, part], pctx())(part)).toBe('week');
  });

  it('a part follows its owner’s place: in Places with a placed parent, Backlog with an unplaced one', () => {
    const parent = task({ id: 'p', place: 'market' });
    const part = task({ id: 'a', parentId: 'p' });
    expect(placer([parent, part], pctx())(parent)).toBe('places');
    expect(placer([parent, part], pctx())(part)).toBe('places');
    expect(foldParts([parent, part])).toEqual([parent]); // drawn inside the parent's card

    const plain = task({ id: 'q' });
    const placedPart = task({ id: 'b', parentId: 'q', place: 'market' });
    expect(placer([plain, placedPart], pctx())(plain)).toBe('backlog');
    expect(placer([plain, placedPart], pctx())(placedPart)).toBe('backlog');
    // A finished parent hands the part back its own place.
    expect(placeOf(placedPart, pctx(), { ...plain, status: 'done' })).toBe('places');
  });

  it('option 3: a timed task is on Today on its day, by its time — a plan row never places it', () => {
    const at = (dueDay: string) => task({ status: 'planned', dueDay, dueTime: '15:00' });
    expect(placeOf(at(TODAY), pctx())).toBe('today');
    expect(placeOf(at('2026-09-24'), pctx(new Map([['x', 0]])))).toBe('week'); // a row today: history
    expect(placeOf(at('2026-09-22'), pctx())).toBe('week'); // overdue
  });

  it('option 3: a deadline before day start is still the night before (the instant’s app day)', () => {
    const at = (dueDay: string, dueTime: string) => task({ dueDay, dueTime });
    const place = (t: Task, h: number) => placeOf(t, pctx(undefined, h));
    expect(place(at('2026-09-24', '00:30'), 4)).toBe('today');
    expect(place(at('2026-09-24', '00:30'), 0)).toBe('week');
    expect(place(at(TODAY, '02:00'), 4)).toBe('week'); // last night's: overdue
    expect(place(at(TODAY, '02:00'), 0)).toBe('today');
    expect(place(at('2026-09-24', '04:00'), 4)).toBe('week');
    expect(place(at('2026-09-30', '00:30'), 4)).toBe('week'); // today+6's night
    expect(place(at('2026-09-30', '00:30'), 0)).toBe('backlog');
  });

  it('option 3: a timed parent due today is not on Today — its deadline is its marker', () => {
    const parent = task({ id: 'p', dueDay: TODAY, dueTime: '23:59' });
    const part = task({ id: 'a', parentId: 'p' });
    expect(placer([parent, part], pctx())(parent)).toBe('week');
  });
});

describe('text search', () => {
  it('t1 normalizes case, accents and whitespace', () => {
    expect(normalize('  Café   RUN ')).toBe('cafe run');
  });
  it('t2 needs every word, in any order', () => {
    const t = task({ title: 'Read chapter 4 notes' });
    expect(matchesText(t, 'notes chapter', labelOf)).toBe(true);
    expect(matchesText(t, 'notes lab', labelOf)).toBe(false);
  });
  it('t3 matches the category label too', () => {
    const t = task({ title: 'pset 3', categoryId: 'c1' });
    expect(matchesText(t, 'csen pset', labelOf)).toBe(true);
  });
  it('t4 blank text matches everything', () => {
    expect(matchesText(task({}), '   ', labelOf)).toBe(true);
  });
  it('t5 matches words in the notes, mixed with the title, accent-blind', () => {
    const t = task({ title: 'pset 4', notes: 'Q6: use the **Lemma**\nCafé hours Thu' });
    expect(matchesText(t, 'lemma', labelOf)).toBe(true);
    expect(matchesText(t, 'pset cafe', labelOf)).toBe(true); // title + notes, AND across both
    expect(matchesText(t, 'pset zebra', labelOf)).toBe(false);
    expect(matchesText(t, 'lemma', labelOf, false)).toBe(false); // the add-to-today picker opts out
  });
  it('t6 flags a match only the notes explain', () => {
    const t = task({ title: 'pset 4', categoryId: 'c1', notes: 'use the lemma' });
    expect(matchedInNotes(t, 'lemma', labelOf)).toBe(true);
    expect(matchedInNotes(t, 'pset lemma', labelOf)).toBe(true);
    expect(matchedInNotes(t, 'csen pset', labelOf)).toBe(false); // title + category explain it
    expect(matchedInNotes(t, 'zebra', labelOf)).toBe(false); // no match at all
    expect(matchedInNotes(t, '  ', labelOf)).toBe(false);
    expect(matchedInNotes(task({ title: 'x' }), 'x', labelOf)).toBe(false);
  });
  it('t7 a legacy task with no notes field still searches by title', () => {
    const legacy = task({ title: 'old row' });
    delete (legacy as { notes?: unknown }).notes;
    expect(matchesText(legacy, 'old', labelOf)).toBe(true);
    expect(matchesText(legacy, 'lemma', labelOf)).toBe(false);
  });
});

describe('applyQuery', () => {
  const tasks = [
    task({ id: 'today', title: 'pset today', status: 'planned', categoryId: 'c1' }),
    task({ id: 'week', title: 'pset week', dueDay: '2026-09-25', categoryId: 'c1' }),
    task({ id: 'later', title: 'pset later', categoryId: 'c2' }),
    task({ id: 'done', title: 'pset done', status: 'done', completedAt: 5 }),
    task({ id: 'loose', title: 'buy stamps' }),
  ];
  const c = ctx([['today', 0]]);

  it('a0 a part folds into its parent’s card outside search; search and Done stay flat', () => {
    const parts = [
      task({ id: 'p', title: 'P2', dueDay: '2026-09-25' }),
      task({ id: 'a', title: 'P2 read', parentId: 'p' }),
      task({ id: 'b', title: 'P2 draft', parentId: 'p', status: 'planned' }),
      task({ id: 'd', title: 'P2 done', parentId: 'p', status: 'done', completedAt: 1 }),
    ];
    const pc = ctx([['b', 0]]);
    const week = applyQuery(parts, 'week', q({}, 'week'), pc);
    expect(week.groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(['p']);
    expect(week.count).toBe(1);
    expect(applyQuery(parts, 'today', q({}, 'today'), pc).count).toBe(1); // b, on today's plan
    const found = applyQuery(parts, 'week', q({ text: 'P2' }, 'week'), pc);
    expect(found.groups.flatMap((g) => g.tasks.map((t) => t.id)).sort()).toEqual(['a', 'b', 'p']);
    expect(applyQuery(parts, 'done', q({}, 'done'), pc).count).toBe(1);
  });

  it('a1 without text shows only the lens’s place', () => {
    const r = applyQuery(tasks, 'backlog', q(), c);
    expect(r.searching).toBe(false);
    expect(r.groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(['later', 'loose']);
  });

  it('a2 text searches every open task, grouped by place', () => {
    const r = applyQuery(tasks, 'backlog', q({ text: 'pset' }), c);
    expect(r.searching).toBe(true);
    expect(r.groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['Today', ['today']],
      ['This week', ['week']],
      ['Backlog', ['later']],
    ]);
  });

  it('a3 search on the Done lens stays in history', () => {
    const r = applyQuery(tasks, 'done', q({ text: 'pset' }, 'done'), c);
    expect(r.groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(['done']);
  });

  it('a4 category filter, with "" meaning no category', () => {
    const ids = (cats: string[]) =>
      applyQuery(tasks, 'backlog', q({ categories: cats }), c).groups.flatMap((g) =>
        g.tasks.map((t) => t.id),
      );
    expect(ids(['c2'])).toEqual(['later']);
    expect(ids([''])).toEqual(['loose']);
  });

  it('a5 the Backlog status chip covers planned-for-another-day tasks', () => {
    const planned = task({ id: 'tmrw', status: 'planned' });
    const r = applyQuery([planned], 'backlog', q({ statuses: ['backlog'] }), ctx());
    expect(r.count).toBe(1);
    expect(applyQuery([planned], 'backlog', q({ statuses: ['in_progress'] }), ctx()).count).toBe(0);
  });

  it('a6 Week is one flat list, soonest due first, whatever the category', () => {
    expect(LENS_PRESET.week).toMatchObject({ sort: 'due', groupBy: 'none' });
    expect(LENS_PRESET.backlog.groupBy).toBe('category');
    const week = [
      task({ id: 'd29', dueDay: '2026-09-29', categoryId: 'c1' }),
      task({ id: 'untimed', dueDay: TODAY }),
      // Timed tomorrow (timed today is on Today — option 3): by clock, before that day's untimed.
      task({ id: 'at14', dueDay: '2026-09-24', dueTime: '14:00', categoryId: 'c1' }),
      task({ id: 'd24', dueDay: '2026-09-24', categoryId: 'c2' }),
      task({ id: 'at09', dueDay: '2026-09-24', dueTime: '09:00', categoryId: 'c2' }),
      task({ id: 'overdue', dueDay: '2026-09-01', categoryId: 'c2' }),
    ];
    const r = applyQuery(week, 'week', q({}, 'week'), ctx());
    expect(r.groups.map((g) => [g.key, g.label])).toEqual([['all', '']]);
    expect(r.groups[0]!.tasks.map((t) => t.id)).toEqual([
      'overdue',
      'untimed',
      'at09',
      'at14',
      'd24',
      'd29',
    ]);
  });

  it('a8 search places a match by the full list — a timed parent is never Today', () => {
    const lab = [
      task({ id: 'p', title: 'Lab report', dueDay: TODAY, dueTime: '23:59' }),
      task({ id: 'a', title: 'read', parentId: 'p' }),
      task({ id: 'b', title: 'draft', parentId: 'p' }),
    ];
    const r = applyQuery(lab, 'backlog', q({ text: 'Lab' }), ctx());
    expect(r.groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['This week', ['p']],
    ]);
  });

  it('a9 search places a part by its parent even when the parent didn’t match', () => {
    const list = [
      task({ id: 'p', title: 'Report', dueDay: '2026-09-26' }),
      task({ id: 'a', title: 'Lab read', parentId: 'p' }),
    ];
    const r = applyQuery(list, 'backlog', q({ text: 'Lab' }), ctx());
    expect(r.groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['This week', ['a']],
    ]);
  });

  it('a10 search puts timed-today first by deadline, ties oldest first, then the plan', () => {
    const list = [
      task({ id: 'plan', title: 'pset plan', status: 'planned' }),
      task({ id: 'newer', title: 'pset newer', dueDay: TODAY, dueTime: '15:00', createdAt: 2 }),
      task({ id: 'night', title: 'pset night', dueDay: '2026-09-24', dueTime: '00:30' }),
      task({ id: 'older', title: 'pset older', dueDay: TODAY, dueTime: '15:00', createdAt: 1 }),
    ];
    const r = applyQuery(list, 'backlog', q({ text: 'pset' }), ctx([['plan', 0]]));
    expect(r.groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['Today', ['older', 'newer', 'night', 'plan']],
    ]);
  });

  // Guard: a flat preset mustn't leak into search, which always groups by place.
  it('a7 search on Week still groups by place', () => {
    const r = applyQuery(tasks, 'week', q({ text: 'pset' }, 'week'), c);
    expect(r.groups.map((g) => g.label)).toEqual(['Today', 'This week', 'Backlog']);
  });
});

describe('due buckets', () => {
  it('d1 today / week / dated / undated', () => {
    const due = (d: string | null) => task({ dueDay: d });
    expect(inDueBucket(due(TODAY), 'today', TODAY, 4)).toBe(true);
    expect(inDueBucket(due('2026-09-24'), 'today', TODAY, 4)).toBe(false);
    expect(inDueBucket(due('2026-09-01'), 'week', TODAY, 4)).toBe(true); // past-due counts
    expect(inDueBucket(due('2026-09-30'), 'week', TODAY, 4)).toBe(false);
    expect(inDueBucket(due('2027-01-01'), 'dated', TODAY, 4)).toBe(true);
    expect(inDueBucket(due(null), 'undated', TODAY, 4)).toBe(true);
    expect(inDueBucket(due(null), 'dated', TODAY, 4)).toBe(false);
  });

  it('d2 a timed task counts by its deadline’s app day — tonight’s small hours are today', () => {
    const at = (d: string, t: string) => task({ dueDay: d, dueTime: t });
    expect(inDueBucket(at('2026-09-24', '00:30'), 'today', TODAY, 4)).toBe(true);
    expect(inDueBucket(at('2026-09-24', '09:00'), 'today', TODAY, 4)).toBe(false);
    expect(inDueBucket(at('2026-09-30', '00:30'), 'week', TODAY, 4)).toBe(true);
    expect(inDueBucket(at('2026-09-30', '00:30'), 'week', TODAY, 0)).toBe(false);
  });
});

describe('sortTasks', () => {
  it('s1 each key', () => {
    const a = task({ id: 'a', title: 'b', createdAt: 1, estimateMin: 30, dueDay: '2026-10-01' });
    const b = task({ id: 'b', title: 'a', createdAt: 2, estimateMin: null, dueDay: '2026-09-24' });
    const c = task({ id: 'c', title: 'c', createdAt: 3, estimateMin: 10, dueDay: null });
    const ids = (k: Parameters<typeof sortTasks>[1]) => sortTasks([a, b, c], k).map((t) => t.id);
    expect(ids('due')).toEqual(['b', 'a', 'c']);
    expect(ids('newest')).toEqual(['c', 'b', 'a']);
    expect(ids('oldest')).toEqual(['a', 'b', 'c']);
    expect(ids('estimate')).toEqual(['c', 'a', 'b']); // unscoped last
    expect(ids('title')).toEqual(['b', 'a', 'c']);
  });

  it('newest orders history by when it was finished', () => {
    const old = task({ id: 'old', createdAt: 9, completedAt: 10 });
    const recent = task({ id: 'recent', createdAt: 1, cancelledAt: 20 });
    expect(sortTasks([old, recent], 'newest').map((t) => t.id)).toEqual(['recent', 'old']);
  });
});

describe('groupTasks', () => {
  it('g1 category groups follow Settings order, retired after, No category last', () => {
    const tasks = [
      task({ id: 'n' }),
      task({ id: 'hw', categoryId: 'hw' }),
      task({ id: 'b', categoryId: 'c2' }),
      task({ id: 'a', categoryId: 'c1' }),
      task({ id: 'gone', categoryId: 'deleted-cat' }),
    ];
    const groups = groupTasks(tasks, 'category', ctx());
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['CSEN 146', ['a']],
      ['CSCI 187', ['b']],
      ['Homework (retired)', ['hw']],
      ['No category', ['n', 'gone']],
    ]);
  });

  it('g2 place groups keep today in plan order, in-progress-off-plan last', () => {
    const tasks = [
      task({ id: 'ip', status: 'in_progress' }),
      task({ id: 'second', status: 'planned' }),
      task({ id: 'first', status: 'planned' }),
    ];
    const groups = groupTasks(
      tasks,
      'place',
      ctx([
        ['first', 0],
        ['second', 1],
      ]),
    );
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(['first', 'second', 'ip']);
  });

  it('g3 a search’s place groups put Places between This week and Backlog', () => {
    const tasks = [
      task({ id: 'b' }),
      task({ id: 'e', place: 'market' }),
      task({ id: 'w', dueDay: TODAY }),
    ];
    expect(groupTasks(tasks, 'place', ctx()).map((g) => g.label)).toEqual([
      'This week',
      'Places',
      'Backlog',
    ]);
  });

  it('never returns an empty group', () => {
    expect(groupTasks([], 'none', ctx())).toEqual([]);
    expect(groupTasks([], 'category', ctx())).toEqual([]);
  });
});

describe('override chips', () => {
  it('c1 lists what differs from the lens preset, and each chip removes itself', () => {
    const query = q({ categories: ['c1', ''], due: 'week', sort: 'newest', groupBy: 'none' });
    const chips = overrideChips(query, 'backlog', CATS);
    expect(chips.map((c) => c.label)).toEqual([
      'CSEN 146',
      'No category',
      'Due this week',
      'Sort: Newest',
      'Ungrouped',
    ]);
    expect(chips[0]!.remove(query).categories).toEqual(['']);
    expect(chips[3]!.remove(query).sort).toBe('due');
    expect(isNarrowing(query)).toBe(true);
  });

  it('c2 grouping flat Week by category is a chip that removes back to flat', () => {
    const query = q({ groupBy: 'category' }, 'week');
    const chips = overrideChips(query, 'week', CATS);
    expect(chips.map((c) => c.label)).toEqual(['By category']);
    expect(chips[0]!.remove(query).groupBy).toBe('none');
    expect(isNarrowing(query)).toBe(false);
  });

  it('the preset hides nothing; text does; a sort or grouping change alone does not', () => {
    expect(isNarrowing(LENS_PRESET.done)).toBe(false);
    expect(overrideChips(LENS_PRESET.week, 'week', CATS)).toEqual([]);
    expect(isNarrowing(q({ text: 'x' }))).toBe(true);
    expect(isNarrowing(q({ sort: 'title', groupBy: 'none' }))).toBe(false);
  });

  it('a task whose category was deleted matches the "No category" filter, like its group', () => {
    const orphan = task({ id: 'o', categoryId: 'deleted-cat' });
    expect(applyQuery([orphan], 'backlog', q({ categories: [''] }), ctx()).count).toBe(1);
  });

  it('reset keeps the search text', () => {
    const r = resetToLens(q({ text: 'pset', due: 'dated', sort: 'title' }), 'week');
    expect(r).toEqual({ ...LENS_PRESET.week, text: 'pset' });
  });
});
