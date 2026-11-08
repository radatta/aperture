import { useMemo } from 'react';
import { Text } from '../../components/Text';
import { useActiveCategories } from '../../data/hooks/useCategories';
import { useSuggestCategory } from '../../data/hooks/useSuggestCategory';

// The chip and its taken state share a box, and "no category" its height, so the tap and a list that arrives
// late move nothing: the bar is bottom-docked, and a row changing height would shift the field and ✨ under
// the thumb.
const SLOT = 'inline-flex min-h-8 max-w-36 items-center rounded-md border px-2 text-xs';

// A label sized for both of the chip's states (`#` is wider than `?`, enough to flip a wrap): the other
// state's text sits behind it as an invisible ::after, so it's never in the DOM's text.
function SlotLabel({ text, other }: { text: string; other: string }) {
  return (
    <span
      data-other={other}
      className="grid min-w-0 grid-cols-[minmax(0,auto)] after:invisible after:col-start-1 after:row-start-1 after:h-0 after:overflow-hidden after:whitespace-nowrap after:content-[attr(data-other)]"
    >
      <span className="col-start-1 row-start-1 min-w-0 truncate">{text}</span>
    </span>
  );
}

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
      <span title={taken} className={`${SLOT} border-transparent text-teal`}>
        <SlotLabel text={`#${taken}`} other={`${taken}?`} />
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
      <SlotLabel text={`${label}?`} other={`#${label}`} />
    </button>
  );
}
