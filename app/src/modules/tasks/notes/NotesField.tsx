import { useEffect, useId, useRef } from 'react';
import { TASK_NOTES_MAX } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Text } from '../../../components/Text';
import { Textarea } from '../../../components/Textarea';
import { NotesView } from './NotesView';
import { notesValue } from './parseNotes';

// The counter stays out of the way until the cap is close.
const COUNTER_FROM = 4500;
const fmt = (n: number) => n.toLocaleString('en-US');

// Notes inside the details form. Shows the rendered note with an Edit button ("Add notes…" when empty);
// once editing, it stays a textarea until the form's Save or the modal's Close — no blur-to-render, no
// preview tab. The value is owned by the form, so it joins the form's dirty guard and single Save.
// Over the cap the counter goes red and the form disables Save; there's no maxLength, so a paste is
// never silently truncated.
export function NotesField({
  saved,
  value,
  editing,
  onEdit,
  onChange,
}: {
  saved: string | null | undefined;
  value: string;
  editing: boolean;
  onEdit: () => void;
  onChange: (value: string) => void;
}) {
  const counterId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const len = notesValue(value).length;
  const over = len > TASK_NOTES_MAX;
  const showCounter = len >= COUNTER_FROM;

  // Entering edit mode moves focus into the textarea, caret at the end.
  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (!editing)
    return (
      <div className="flex flex-col gap-1">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <Text size="sm" tone="muted">
            Notes
          </Text>
          {saved && (
            <Button variant="quiet" size="sm" onClick={onEdit} aria-label="Edit notes">
              Edit
            </Button>
          )}
        </div>
        {saved ? (
          <NotesView source={saved} />
        ) : (
          <Button variant="quiet" size="sm" className="self-start" onClick={onEdit}>
            Add notes…
          </Button>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        ref={ref}
        label="Notes"
        autogrow
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Context, links, a checklist. **bold**, *italic*, - lists, [text](https://…)"
        aria-invalid={over || undefined}
        aria-describedby={showCounter ? counterId : undefined}
        className="text-sm"
      />
      {showCounter && (
        <Text
          id={counterId}
          size="xs"
          tabular
          tone={over ? 'danger' : 'muted'}
          className="self-end"
        >
          {fmt(len)} / {fmt(TASK_NOTES_MAX)}
          {over && ' · too long to save'}
        </Text>
      )}
    </div>
  );
}
