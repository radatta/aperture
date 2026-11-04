import { useCategories } from '../../data/hooks/useCategories';

// Labels resolve live from the categories roster (renames propagate) — the task only stores the id.
// No category renders nothing at all. "Uncategorized" on every unscoped row is a label for the
// absence of a label — pure noise at the same weight as the real ones.
export function CategoryTag({ categoryId }: { categoryId: string | null }) {
  const { data: cats, isError } = useCategories();
  // A failed roster read can't resolve the label, and nothing would read as "uncategorized": mark the
  // absence instead. A per-card red line would be noise; the page's own categories error (QueryControls on
  // the Tasks lenses) carries the Retry.
  if (categoryId && isError && !cats)
    return (
      <span
        title="Couldn’t load categories"
        role="img"
        aria-label="Category unknown — couldn’t load categories"
        className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-subtle"
      >
        —
      </span>
    );
  const label = categoryId ? cats?.find((c) => c.id === categoryId)?.label : null;
  if (!label) return null;
  return (
    // Capped at the row's width and truncated: a long course name must not run under the row's actions.
    <span
      title={label}
      className="max-w-full truncate rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted"
    >
      {label}
    </span>
  );
}
