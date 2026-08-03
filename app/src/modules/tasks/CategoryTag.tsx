import { Text } from '../../components/Text';
import { useCategories } from '../../data/hooks/useCategories';

// Labels resolve live from the categories roster (renames propagate) — the task only stores the id.
export function CategoryTag({ categoryId }: { categoryId: string | null }) {
  const { data: cats = [] } = useCategories();
  const label = categoryId ? cats.find((c) => c.id === categoryId)?.label : null;
  if (!label)
    return (
      <Text size="xs" tone="subtle">
        Uncategorized
      </Text>
    );
  return (
    <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted">
      {label}
    </span>
  );
}
