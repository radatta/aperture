import {
  addDays,
  areaOf,
  AREAS,
  byTimeOn,
  deadlineOf,
  isDeadlineOccurrence,
  LIFE_AREAS,
  placedByTime,
  placeTasks,
  timedDay,
  timeDecidesDay,
} from '@aperture/shared';
import type { Area, Category, Task } from '@aperture/shared';
import { byDueHint } from './taskMath';
import { byDeadline } from './todayRows';

// The /tasks query engine: every list view is a preset lens over one task list. Pure — the page
// feeds it tasks + today's plan and renders what comes back. See docs/areas/tasks/lenses.md.

// Where an open task lives. Exactly one home per task, so Today, Week, Backlog and Done never show a task
// twice. ('places' is the home of an errand nothing else claims — a task on a store's list, places.ts — not
// to be confused with this type. The Places lens itself lists every open errand, errandsByPlace.)
export type Place = 'today' | 'week' | 'places' | 'backlog' | 'done';
export type LensId = Place | 'recurring' | 'calibration';
export type DueBucket = 'any' | 'today' | 'week' | 'dated' | 'undated';
export type SortKey = 'due' | 'newest' | 'oldest' | 'estimate' | 'title';
export type GroupKey = 'none' | 'category' | 'place';
// 'backlog' covers planned too — a task planned for another day is still waiting, from here.
export type StatusChip = 'backlog' | 'in_progress' | 'done' | 'cancelled';

export interface TaskQuery {
  text: string;
  categories: string[]; // '' = no category
  statuses: StatusChip[];
  due: DueBucket;
  sort: SortKey;
  groupBy: GroupKey;
  // Life areas shown (areas.ts): [] = every area. Backlog's preset is the life areas — Aperture folds away
  // behind its chip (lenses.md D14). Ignored while searching: typing finds everything (D1).
  areas: Area[];
}

export interface QueryCtx {
  today: string;
  // Today's plan: taskId → plan order. Being on it is what puts a task in the Today place.
  planOrder: Map<string, number>;
  categories: Category[];
  dayStartHour: number;
}
type PlaceCtx = Pick<QueryCtx, 'today' | 'planOrder' | 'dayStartHour'>;

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

// "This week" = today through today+6. Past-due counts too: it's the most urgent thing there is.
export const WEEK_DAYS = 6;
// A group this big starts collapsed on first visit; smaller ones start open.
export const COLLAPSE_AT = 8;

export const PLACES: Place[] = ['today', 'week', 'places', 'backlog', 'done'];
export const PLACE_LABEL: Record<Place, string> = {
  today: 'Today',
  week: 'This week',
  places: 'Places',
  backlog: 'Backlog',
  done: 'Done',
};

export const isPlace = (lens: LensId): lens is Place => (PLACES as string[]).includes(lens);

// A part not on today answers to its parent's deadline (its own time is when its block ends), so it
// lives where its open parent does — and folds under that parent's card there (parts.ts). A timed task
// is on Today on the app day its deadline falls on, and a plan row on it places nothing (option 3,
// lenses.md D13); a parent's deadline is its marker, never Today. Placement reads the app day, as the
// due chips and labels do ("due tonight 12:30am"). An errand (a task on a store's list) that nothing
// above claimed lives in 'places', never the Backlog — a part by its owner's place, so it stays folded
// under its parent wherever that lands. (Every open errand also shows on the Places lens, whatever its home.)
export function placeOf(task: Task, ctx: PlaceCtx, parent?: Task, isParent = false): Place {
  if (task.status === 'done' || task.status === 'cancelled') return 'done';
  if (task.status === 'in_progress') return 'today';
  const { today, dayStartHour } = ctx;
  const onToday =
    timeDecidesDay(task) && !isParent
      ? placedByTime(task, today, dayStartHour)
      : // A series deadline occurrence (recurring.md D8) is planned, and on its due day by time too.
        ctx.planOrder.has(task.id) ||
        (isDeadlineOccurrence(task) && placedByTime(task, today, dayStartHour));
  if (onToday) return 'today';
  const openParent = parent && parent.status !== 'done' && parent.status !== 'cancelled';
  const owner = openParent ? parent : task;
  const due = timedDay(owner, dayStartHour) ?? owner.dueDay;
  if (due && due <= addDays(today, WEEK_DAYS)) return 'week';
  return owner.place ? 'places' : 'backlog';
}

// placeOf over a list, each part looked up against its parent.
export function placer(tasks: Task[], ctx: PlaceCtx) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const parents = new Set(tasks.map((t) => t.parentId).filter((id): id is string => !!id));
  return (t: Task): Place =>
    placeOf(t, ctx, t.parentId ? byId.get(t.parentId) : undefined, parents.has(t.id));
}

// The Places lens's rows, store by store: every open errand, as the Shortcut's digest lists them (places.ts
// placeTasks — a parent with open parts gives way to them), whatever its home — one dated this week, on
// today's plan or started shows on Week/Today too. So the lens, its pill, Settings' counts and the
// notification count the same things. Keyed by slug, each list oldest first; empty lists are left out.
export function errandsByPlace(tasks: Task[]): Map<string, Task[]> {
  const slugs = new Set(tasks.flatMap((t) => (t.place ? [t.place] : [])));
  const lists = new Map<string, Task[]>();
  for (const s of slugs) {
    const list = placeTasks(s, tasks);
    if (list.length) lists.set(s, list);
  }
  return lists;
}

// Outside a search, a part whose parent is in the same list is drawn inside the parent's card, not as a
// row of its own — the deliverable stays one thing you plan from.
export function foldParts(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => !(t.parentId && ids.has(t.parentId)));
}

// Presets carry only how a lens sorts and groups; which tasks it shows is placeOf's job (errandsByPlace's,
// on Places).
const BLANK = { text: '', due: 'any', areas: [] as Area[] } as const;
export const LENS_PRESET: Record<Place, TaskQuery> = {
  today: { ...BLANK, categories: [], statuses: [], sort: 'due', groupBy: 'none' },
  // Flat: the only question on Week is what's due next, and every row already carries its category.
  week: { ...BLANK, categories: [], statuses: [], sort: 'due', groupBy: 'none' },
  // Drawn by PlacesLens (grouped by store, oldest first); this preset only shapes a search from it.
  places: { ...BLANK, categories: [], statuses: [], sort: 'oldest', groupBy: 'none' },
  // The life backlog: Aperture-area work waits behind "Aperture · N" (D14).
  backlog: {
    ...BLANK,
    categories: [],
    statuses: [],
    sort: 'due',
    groupBy: 'category',
    areas: LIFE_AREAS,
  },
  done: { ...BLANK, categories: [], statuses: [], sort: 'newest', groupBy: 'none' },
};

// A task's life area is its category's; no category (or an id with no category behind it) reads as Personal.
export function areaOfFrom(categories: Category[]): (t: Task) => Area {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (t) => areaOf(t.categoryId ? byId.get(t.categoryId) : null);
}

// Which areas a lens's preset folds away — the ones its chips toggle (Backlog: Aperture; the rest: none).
export const foldedAreas = (lens: Place): Area[] => {
  const shown = LENS_PRESET[lens].areas;
  return shown.length ? AREAS.filter((a) => !shown.includes(a)) : [];
};

export const areaShown = (q: TaskQuery, area: Area): boolean =>
  q.areas.length === 0 || q.areas.includes(area);

// Show or hide one area. Showing the last hidden one reads as "every area" ([]), so a query never carries
// the full list by accident.
export function toggleArea(q: TaskQuery, area: Area): TaskQuery {
  const shown = q.areas.length ? q.areas : [...AREAS];
  const next = areaShown(q, area) ? shown.filter((a) => a !== area) : [...shown, area];
  return { ...q, areas: next.length === AREAS.length ? [] : AREAS.filter((a) => next.includes(a)) };
}

// Cards per area among the tasks living in `lens` — the chips' counts, whatever the query hides or shows.
export function areaCardCounts(
  tasks: Task[],
  lens: Place,
  ctx: QueryCtx,
): Partial<Record<Area, number>> {
  const place = placer(tasks, ctx);
  const area = areaOfFrom(ctx.categories);
  const counts: Partial<Record<Area, number>> = {};
  for (const t of foldParts(tasks.filter((t) => place(t) === lens)))
    counts[area(t)] = (counts[area(t)] ?? 0) + 1;
  return counts;
}

// Lowercase, accents stripped, whitespace collapsed — "Café  Run" finds "cafe run".
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Notes can run to 5,000 characters, so each task object's normalized notes are computed once, not per
// keystroke. A refetch hands back new objects, so an edited note is never read stale.
const notesHay = new WeakMap<Task, string>();
function notesOf(task: Task): string {
  if (!task.notes) return '';
  let hay = notesHay.get(task);
  if (hay === undefined) notesHay.set(task, (hay = normalize(task.notes)));
  return hay;
}

const tokensOf = (text: string) => normalize(text).split(' ').filter(Boolean);
const titleHay = (task: Task, labelOf: (id: string | null) => string) =>
  normalize(`${task.title} ${labelOf(task.categoryId)}`);

// Every word must appear somewhere in the title, the category label, or (unless withNotes is off) the
// notes. The add-to-today picker turns notes off: it finds-or-creates by title.
export function matchesText(
  task: Task,
  text: string,
  labelOf: (id: string | null) => string,
  withNotes = true,
): boolean {
  const tokens = tokensOf(text);
  if (tokens.length === 0) return true;
  const hay = titleHay(task, labelOf);
  const notes = withNotes ? notesOf(task) : '';
  return tokens.every((t) => hay.includes(t) || notes.includes(t));
}

// The row's "in notes" hint: the search matches, but the title and category alone don't explain it.
export function matchedInNotes(
  task: Task,
  text: string,
  labelOf: (id: string | null) => string,
): boolean {
  const tokens = tokensOf(text);
  if (tokens.length === 0 || !task.notes) return false;
  const hay = titleHay(task, labelOf);
  return !tokens.every((t) => hay.includes(t)) && matchesText(task, text, labelOf);
}

function matchesStatus(task: Task, statuses: StatusChip[]): boolean {
  if (statuses.length === 0) return true;
  const chip: StatusChip = task.status === 'planned' ? 'backlog' : task.status;
  return statuses.includes(chip);
}

// A timed task's day here is its deadline's app day, as placeOf reads it (lenses.md D13).
export function inDueBucket(
  task: Task,
  due: DueBucket,
  today: string,
  dayStartHour: number,
): boolean {
  const d = timedDay(task, dayStartHour) ?? (task.dueDay || null);
  switch (due) {
    case 'any':
      return true;
    case 'today':
      return d === today;
    case 'week':
      return d !== null && d <= addDays(today, WEEK_DAYS);
    case 'dated':
      return d !== null;
    case 'undated':
      return d === null;
  }
}

// When a task left the list — for done/dropped history "newest" means most recently finished.
const stamp = (t: Task) => t.completedAt ?? t.cancelledAt ?? t.createdAt;

export function sortTasks(tasks: Task[], sort: SortKey): Task[] {
  switch (sort) {
    case 'due':
      return byDueHint(tasks);
    case 'newest':
      return [...tasks].sort((a, b) => stamp(b) - stamp(a));
    case 'oldest':
      return [...tasks].sort((a, b) => stamp(a) - stamp(b));
    case 'estimate':
      // Unscoped last: "what's quick" is the question, and an unknown isn't quick.
      return [...tasks].sort((a, b) => (a.estimateMin ?? Infinity) - (b.estimateMin ?? Infinity));
    case 'title':
      return [...tasks].sort((a, b) => a.title.localeCompare(b.title));
  }
}

export function labelOfFrom(categories: Category[]): (id: string | null) => string {
  const byId = new Map(categories.map((c) => [c.id, c.label]));
  return (id) => (id ? (byId.get(id) ?? '') : '');
}

// Category groups follow the Settings order; retired categories that still hold tasks come after the
// active ones, and "No category" is always last. Empty groups are never returned. `place` defaults to
// placing within `tasks`; a search passes the one built over the full list, so a match whose parent
// didn't match still places by it.
export function groupTasks(
  tasks: Task[],
  groupBy: GroupKey,
  ctx: QueryCtx,
  place = placer(tasks, ctx),
): TaskGroup[] {
  if (groupBy === 'none') return tasks.length ? [{ key: 'all', label: '', tasks }] : [];
  if (groupBy === 'place') {
    return PLACES.map((p) => {
      const inPlace = tasks.filter((t) => place(t) === p);
      // Today keeps the plan's order (the Big 3 is the top of it), in-progress-off-plan after.
      const ordered =
        p === 'today'
          ? inPlace
              // As the Today lens reads: by time first (by deadline, ties oldest first), then the plan.
              .map((t, i) => ({
                t,
                i,
                timed: byTimeOn(t, ctx.today, ctx.dayStartHour, ctx.planOrder.has(t.id)) ? 0 : 1,
                o: ctx.planOrder.get(t.id) ?? Infinity,
              }))
              .sort(
                (a, b) =>
                  a.timed - b.timed ||
                  (a.timed === 0
                    ? byDeadline(a.t, b.t) || a.t.createdAt - b.t.createdAt
                    : a.o - b.o) ||
                  a.i - b.i,
              )
              .map((x) => x.t)
          : inPlace;
      return { key: p, label: PLACE_LABEL[p], tasks: ordered };
    }).filter((g) => g.tasks.length > 0);
  }
  const cats = [...ctx.categories].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.order - b.order,
  );
  const groups: TaskGroup[] = cats.map((c) => ({
    key: c.id,
    label: c.active ? c.label : `${c.label} (retired)`,
    tasks: tasks.filter((t) => t.categoryId === c.id),
  }));
  const known = new Set(cats.map((c) => c.id));
  groups.push({
    key: 'none',
    label: 'No category',
    tasks: tasks.filter((t) => !t.categoryId || !known.has(t.categoryId)),
  });
  return groups.filter((g) => g.tasks.length > 0);
}

export interface QueryResult {
  searching: boolean;
  groups: TaskGroup[];
  count: number;
}

// Empty text: the lens's place, filtered. Non-empty text: every open task (history, on the Done
// lens) regardless of place, grouped by where each one lives — typing searches everything.
export function applyQuery(tasks: Task[], lens: Place, q: TaskQuery, ctx: QueryCtx): QueryResult {
  const labelOf = labelOfFrom(ctx.categories);
  const known = new Set(ctx.categories.map((c) => c.id));
  // Same rule as the "No category" group: an id with no category behind it counts as none.
  const catOf = (t: Task) => (t.categoryId && known.has(t.categoryId) ? t.categoryId : '');
  const searching = normalize(q.text) !== '';
  const place = placer(tasks, ctx);
  const area = areaOfFrom(ctx.categories);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // A part folded under its parent's card (same list) is in its parent's area, as it is in its place —
  // the card is one thing, and areaCardCounts counts it once, by the parent.
  const areaOfOwner = (t: Task) => {
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    return area(parent && place(parent) === place(t) ? parent : t);
  };
  // A part's due filter is its parent's deadline, like its place (its own time is when its block ends).
  const deadline = (t: Task) => ({ ...t, ...deadlineOf(t, tasks) });
  const matched = tasks.filter(
    (t) =>
      (searching ? (lens === 'done') === (place(t) === 'done') : place(t) === lens) &&
      (searching || areaShown(q, areaOfOwner(t))) &&
      (q.categories.length === 0 || q.categories.includes(catOf(t))) &&
      matchesStatus(t, q.statuses) &&
      inDueBucket(deadline(t), q.due, ctx.today, ctx.dayStartHour) &&
      matchesText(t, q.text, labelOf),
  );
  // Search stays flat (every match is a card); the Done lens is flat history.
  const shown = searching || lens === 'done' ? matched : foldParts(matched);
  const sorted = sortTasks(shown, q.sort);
  const groupBy = searching && lens !== 'done' ? 'place' : q.groupBy;
  return { searching, groups: groupTasks(sorted, groupBy, ctx, place), count: shown.length };
}

// What the reader changed from the lens's own preset (text aside) — drives "Filter · N" + chips.
export interface OverrideChip {
  id: string;
  label: string;
  remove: (q: TaskQuery) => TaskQuery;
}

const DUE_LABEL: Record<DueBucket, string> = {
  any: 'Any',
  today: 'Due today',
  week: 'Due this week',
  dated: 'Has a due day',
  undated: 'No due day',
};
export const SORT_LABEL: Record<SortKey, string> = {
  due: 'Due',
  newest: 'Newest',
  oldest: 'Oldest',
  estimate: 'Estimate',
  title: 'Title',
};
export const STATUS_LABEL: Record<StatusChip, string> = {
  backlog: 'Backlog',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Dropped',
};

export function overrideChips(q: TaskQuery, lens: Place, categories: Category[]): OverrideChip[] {
  const preset = LENS_PRESET[lens];
  const labelOf = labelOfFrom(categories);
  const chips: OverrideChip[] = q.categories.map((id) => ({
    id: `cat:${id}`,
    label: id === '' ? 'No category' : labelOf(id) || 'Unknown category',
    remove: (x) => ({ ...x, categories: x.categories.filter((c) => c !== id) }),
  }));
  for (const s of q.statuses)
    chips.push({
      id: `status:${s}`,
      label: STATUS_LABEL[s],
      remove: (x) => ({ ...x, statuses: x.statuses.filter((v) => v !== s) }),
    });
  if (q.due !== 'any')
    chips.push({ id: 'due', label: DUE_LABEL[q.due], remove: (x) => ({ ...x, due: 'any' }) });
  if (q.sort !== preset.sort)
    chips.push({
      id: 'sort',
      label: `Sort: ${SORT_LABEL[q.sort]}`,
      remove: (x) => ({ ...x, sort: preset.sort }),
    });
  if (q.groupBy !== preset.groupBy)
    chips.push({
      id: 'group',
      label: q.groupBy === 'none' ? 'Ungrouped' : 'By category',
      remove: (x) => ({ ...x, groupBy: preset.groupBy }),
    });
  return chips;
}

// Does the query hide anything? Search or a filter does; a different sort or grouping doesn't.
export const isNarrowing = (q: TaskQuery): boolean =>
  normalize(q.text) !== '' || q.categories.length > 0 || q.statuses.length > 0 || q.due !== 'any';

// Back to the lens's preset, keeping what's typed in the search box.
export const resetToLens = (q: TaskQuery, lens: Place): TaskQuery => ({
  ...LENS_PRESET[lens],
  text: q.text,
});
