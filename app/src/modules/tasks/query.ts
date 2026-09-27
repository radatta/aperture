import { addDays } from '@aperture/shared';
import type { Category, Task } from '@aperture/shared';
import { byDueHint } from './taskMath';

// The /tasks query engine: every list view is a preset lens over one task list. Pure — the page
// feeds it tasks + today's plan and renders what comes back. See docs/areas/tasks/lenses.md.

// Where an open task lives. Exactly one place per task, so lenses never show a task twice.
export type Place = 'today' | 'week' | 'backlog' | 'done';
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
}

export interface QueryCtx {
  today: string;
  // Today's plan: taskId → plan order. Being on it is what puts a task in the Today place.
  planOrder: Map<string, number>;
  categories: Category[];
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

// "This week" = today through today+6. Past-due counts too: it's the most urgent thing there is.
export const WEEK_DAYS = 6;
// A group this big starts collapsed on first visit; smaller ones start open.
export const COLLAPSE_AT = 8;

export const PLACES: Place[] = ['today', 'week', 'backlog', 'done'];
export const PLACE_LABEL: Record<Place, string> = {
  today: 'Today',
  week: 'This week',
  backlog: 'Backlog',
  done: 'Done',
};

export const isPlace = (lens: LensId): lens is Place => (PLACES as string[]).includes(lens);

export function placeOf(task: Task, today: string, planOrder: Map<string, number>): Place {
  if (task.status === 'done' || task.status === 'cancelled') return 'done';
  if (planOrder.has(task.id) || task.status === 'in_progress') return 'today';
  if (task.dueDay && task.dueDay <= addDays(today, WEEK_DAYS)) return 'week';
  return 'backlog';
}

// Presets carry only how a lens sorts and groups; which tasks it shows is placeOf's job.
const BLANK = { text: '', due: 'any' } as const;
export const LENS_PRESET: Record<Place, TaskQuery> = {
  today: { ...BLANK, categories: [], statuses: [], sort: 'due', groupBy: 'none' },
  week: { ...BLANK, categories: [], statuses: [], sort: 'due', groupBy: 'category' },
  backlog: { ...BLANK, categories: [], statuses: [], sort: 'due', groupBy: 'category' },
  done: { ...BLANK, categories: [], statuses: [], sort: 'newest', groupBy: 'none' },
};

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

export function inDueBucket(task: Task, due: DueBucket, today: string): boolean {
  const d = task.dueDay || null;
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
// active ones, and "No category" is always last. Empty groups are never returned.
export function groupTasks(tasks: Task[], groupBy: GroupKey, ctx: QueryCtx): TaskGroup[] {
  if (groupBy === 'none') return tasks.length ? [{ key: 'all', label: '', tasks }] : [];
  if (groupBy === 'place') {
    return PLACES.map((p) => {
      const inPlace = tasks.filter((t) => placeOf(t, ctx.today, ctx.planOrder) === p);
      // Today keeps the plan's order (the Big 3 is the top of it), in-progress-off-plan after.
      const ordered =
        p === 'today'
          ? inPlace
              .map((t, i) => ({ t, i, o: ctx.planOrder.get(t.id) ?? Infinity }))
              .sort((a, b) => a.o - b.o || a.i - b.i)
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
  const place = (t: Task) => placeOf(t, ctx.today, ctx.planOrder);
  const matched = tasks.filter(
    (t) =>
      (searching ? (lens === 'done') === (place(t) === 'done') : place(t) === lens) &&
      (q.categories.length === 0 || q.categories.includes(catOf(t))) &&
      matchesStatus(t, q.statuses) &&
      inDueBucket(t, q.due, ctx.today) &&
      matchesText(t, q.text, labelOf),
  );
  const sorted = sortTasks(matched, q.sort);
  const groupBy = searching && lens !== 'done' ? 'place' : q.groupBy;
  return { searching, groups: groupTasks(sorted, groupBy, ctx), count: matched.length };
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
