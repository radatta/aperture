// Life areas (docs/areas/tasks/areas.md): the axis orthogonal to category — which part of life a category
// belongs to. Fixed set, in display order; a fifth value is one entry here. An area lives on the category,
// never on the task, so every task has one the moment its category does; a category with none (null, or a
// row from before the field) reads as Personal. Live grouping only — never snapshotted (isWork is).
export const AREAS = ['school', 'aperture', 'recruiting', 'personal'] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABEL: Record<Area, string> = {
  school: 'School',
  aperture: 'Aperture',
  recruiting: 'Recruiting',
  personal: 'Personal',
};

export const DEFAULT_AREA: Area = 'personal';

// The life backlog: every area but Aperture. The Backlog lens folds Aperture away by default behind a chip,
// and Home's "+ Add" count and picker list only these (docs/areas/tasks/lenses.md D14). Today and Week never
// filter by area — a dev ticket due Friday is still due Friday.
export const LIFE_AREAS: Area[] = AREAS.filter((a) => a !== 'aperture');

// Is a task in the life backlog? Its category's area is a life area; no category (or an id with no category
// behind it) reads as Personal, so it is. The one predicate Home's count and the "+ Add" picker share.
export function lifeFrom(
  categories: { id: string; area?: Area | null }[],
): (t: { categoryId: string | null }) => boolean {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return (t) => LIFE_AREAS.includes(areaOf(t.categoryId ? byId.get(t.categoryId) : null));
}

export const isArea = (v: unknown): v is Area => (AREAS as readonly unknown[]).includes(v);

// The one place "no area" turns into Personal. Takes the category (or none — a task with no category).
export const areaOf = (category: { area?: Area | null } | null | undefined): Area =>
  category?.area ?? DEFAULT_AREA;

export const areaError = (v: unknown): string =>
  `area must be one of ${AREAS.join(', ')} (got ${JSON.stringify(v)})`;

// Both impls refuse a value outside the set before writing anything.
export function assertArea(v: unknown): asserts v is Area | null {
  if (v !== null && !isArea(v)) throw new Error(areaError(v));
}
