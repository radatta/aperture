import { useMemo } from 'react';
import { Text } from '../../components/Text';
import { useActiveCategories } from '../../data/hooks/useCategories';
import { useSuggestCategory } from '../../data/hooks/useSuggestCategory';

// Width and height shared by every state, so the tap and a list that arrives late move nothing: the bar is
// bottom-docked, and a row changing height would shift the field and ✨ under the thumb.
const SLOT = 'inline-flex min-h-8 max-w-36 items-center rounded-md border px-2 text-xs';

// The Review preview's category slot when the parse found none: a tap-only ghost chip when the user's own
// history is confident (shared `suggestCategory`, the editor's chip and gates), else the plain "no
// category"; once tapped, the category it took. Mounted only then, so a capture nobody reviews never
// fetches the task list.
export function PreviewCategory({
  title,
  notes,
  taken,
  onTake,
}: {
  title: string;
  notes?: string | null;
  taken: string | null;
  onTake: (categoryId: string, label: string, byKeyboard: boolean) => void;
}) {
  const suggest = useSuggestCategory();
  const { data: categories } = useActiveCategories();
  const suggestion = useMemo(() => suggest({ title, notes }), [suggest, title, notes]);
  const label = suggestion && categories?.find((c) => c.id === suggestion.categoryId)?.label;
  if (taken)
    return (
      <span className={`${SLOT} border-transparent text-teal`}>
        <span className="min-w-0 truncate">#{taken}</span>
      </span>
    );
  if (!suggestion || !label)
    return (
      <Text size="xs" tone="muted" className="inline-flex min-h-8 items-center">
        no category
      </Text>
    );
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keeps the field's focus, so the phone keyboard stays up
      onClick={(e) => onTake(suggestion.categoryId, label, e.detail === 0)}
      aria-label={`Use suggested category ${label}`}
      aria-description="From your other tasks — tap to use"
      title="From your other tasks — tap to use"
      className={`${SLOT} border-dashed border-line text-ink-muted hover:text-ink`}
    >
      <span className="min-w-0 truncate">{label}?</span>
    </button>
  );
}
