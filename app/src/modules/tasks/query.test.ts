import { describe, expect, it } from 'vitest';
import type { Category, Task } from '@aperture/shared';
import {
  applyQuery,
  groupTasks,
  inDueBucket,
  isNarrowing,
  LENS_PRESET,
  matchedInNotes,
  matchesText,
  normalize,
  overrideChips,
  placeOf,
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
  splitFromId: null,
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
  ] as const)('%s', (_name, t, plan, want) => {
    expect(placeOf(t, TODAY, plan as Map<string, number>)).toBe(want);
  });

  it('treats an empty-string dueDay as undated', () => {
    expect(placeOf(task({ dueDay: '' }), TODAY, none)).toBe('backlog');
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
      task({ id: 'at14', dueDay: TODAY, dueTime: '14:00', categoryId: 'c1' }),
      task({ id: 'd24', dueDay: '2026-09-24', categoryId: 'c2' }),
      task({ id: 'at09', dueDay: TODAY, dueTime: '09:00', categoryId: 'c2' }),
      task({ id: 'overdue', dueDay: '2026-09-01', categoryId: 'c2' }),
    ];
    const r = applyQuery(week, 'week', q({}, 'week'), ctx());
    expect(r.groups.map((g) => [g.key, g.label])).toEqual([['all', '']]);
    expect(r.groups[0]!.tasks.map((t) => t.id)).toEqual([
      'overdue',
      'at09',
      'at14',
      'untimed',
      'd24',
      'd29',
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
    expect(inDueBucket(due(TODAY), 'today', TODAY)).toBe(true);
    expect(inDueBucket(due('2026-09-24'), 'today', TODAY)).toBe(false);
    expect(inDueBucket(due('2026-09-01'), 'week', TODAY)).toBe(true); // past-due counts
    expect(inDueBucket(due('2026-09-30'), 'week', TODAY)).toBe(false);
    expect(inDueBucket(due('2027-01-01'), 'dated', TODAY)).toBe(true);
    expect(inDueBucket(due(null), 'undated', TODAY)).toBe(true);
    expect(inDueBucket(due(null), 'dated', TODAY)).toBe(false);
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
