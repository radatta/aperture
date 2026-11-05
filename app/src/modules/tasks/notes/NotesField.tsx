import { useEffect, useId, useRef } from 'react';
import { TASK_NOTES_MAX } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Text } from '../../../components/Text';
import { Textarea } from '../../../components/Textarea';
import { NotesView } from './NotesView';
import { notesValue } from './parseNotes';

const fmt = (n: number) => n.toLocaleString('en-US');

// Notes inside the details form. Shows the rendered note with an Edit button ("Add notes…" when empty);
// once editing, it stays a textarea until the form's Save or the modal's Close — no blur-to-render, no
// preview tab. The value is owned by the form, so it joins the form's dirty guard and single Save.
// Over the cap the counter goes red and the form disables Save; there's no maxLength, so a paste is
// never silently truncated. `focusOnEdit` off leaves focus where it is (the Done form keeps it on Actual).
export function NotesField({
  saved,
  value,
  editing,
  onEdit,
  onChange,
  label = 'Notes',
  max = TASK_NOTES_MAX,
  counterFrom = 4500, // the counter stays out of the way until the cap is close
  rows = 4,
  placeholder = 'Context, links, a checklist. **bold**, *italic*, - lists, [text](https://…)',
  emptyLabel = 'Add notes…',
  plural = true, // "Notes are …" / "Reflection is …"
  focusOnEdit = true,
}: {
  saved: string | null | undefined;
  value: string;
  editing: boolean;
  onEdit: () => void;
  onChange: (value: string) => void;
  label?: string;
  max?: number;
  counterFrom?: number;
  rows?: number;
  placeholder?: string;
  emptyLabel?: string;
  plural?: boolean;
  focusOnEdit?: boolean;
}) {
  const counterId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const len = notesValue(value).length;
  const over = len > max;
  const showCounter = len >= counterFrom;

  // Entering edit mode moves focus into the textarea, caret at the end.
  useEffect(() => {
    const el = ref.current;
    if (!editing || !focusOnEdit || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing, focusOnEdit]);

  if (!editing)
    return (
      <div className="flex flex-col gap-1">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <Text size="sm" tone="muted">
            {label}
          </Text>
          {saved && (
            <Button
              variant="quiet"
              size="sm"
              className="-mr-3"
              onClick={onEdit}
              aria-label={`Edit ${label.toLowerCase()}`}
            >
              Edit
            </Button>
          )}
        </div>
        {saved ? (
          <NotesView source={saved} />
        ) : (
          <Button variant="quiet" size="sm" className="self-start" onClick={onEdit}>
            {emptyLabel}
          </Button>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        ref={ref}
        label={label}
        autogrow
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={over || undefined}
        aria-describedby={showCounter ? counterId : undefined}
        className="text-base" // 16px: anything smaller zooms iOS Safari on focus
      />
      {showCounter && (
        <Text
          id={counterId}
          size="xs"
          tabular
          tone={over ? 'danger' : 'muted'}
          className="self-end"
        >
          {fmt(len)} / {fmt(max)}
          {over && ' · too long to save'}
        </Text>
      )}
      {/* Announces only the crossing, not every keystroke the counter ticks through. */}
      <span role="status" className="sr-only">
        {over
          ? `${label} ${plural ? 'are' : 'is'} over ${fmt(max)} characters — too long to save`
          : ''}
      </span>
    </div>
  );
}
