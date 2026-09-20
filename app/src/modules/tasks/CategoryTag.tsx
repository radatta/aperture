import { useCategories } from '../../data/hooks/useCategories';

// Labels resolve live from the categories roster (renames propagate) — the task only stores the id.
// No category renders nothing at all. "Uncategorized" on every unscoped row is a label for the
// absence of a label — pure noise at the same weight as the real ones.
export function CategoryTag({ categoryId }: { categoryId: string | null }) {
  const { data: cats = [] } = useCategories();
  const label = categoryId ? cats.find((c) => c.id === categoryId)?.label : null;
  if (!label) return null;
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted">
      {label}
    </span>
  );
}
