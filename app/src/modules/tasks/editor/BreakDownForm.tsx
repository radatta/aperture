import { useState } from 'react';
import { parseBulkTasks } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Text } from '../../../components/Text';
import { Textarea } from '../../../components/Textarea';
import { useCreateTasks } from '../../../data/hooks/useTasks';
import { fmtDuration } from '../../../lib/format';

// A line's parse errors, plus the tokens a part can't take: its category is its parent's, and the
// deadline belongs to the parent (a part's own time is set on the part, as when its block ends).
function lineErrors(line: ReturnType<typeof parseBulkTasks>['lines'][number]): string[] {
  const out = [...line.errors];
  if (line.categoryLabel !== null) out.push('a part takes its parent’s category — drop the #');
  if (line.dueDay !== null) out.push('the deadline is the parent’s — drop the due:');
  return out;
}

// Add parts to a task, one per line: `title | ~minutes` (the bulk-add grammar, minutes only). On a task
// with no parts yet it becomes their parent: its own estimate prefills the first line (so nothing is
// lost), and if it was on a plan the first part takes its spot (parts.ts).
export function BreakDownForm({
  task,
  isParent,
  onDone,
  onCancel,
}: {
  task: Task;
  isParent: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const create = useCreateTasks();
  const [text, setText] = useState(() =>
    !isParent && task.estimateMin != null ? `${task.title} | ~${task.estimateMin}` : '',
  );
  const parsed = parseBulkTasks(text, []);
  const errors = parsed.lines.flatMap((l) => lineErrors(l).map((e) => `Line ${l.line}: ${e}`));
  const count = parsed.lines.length;
  const est = parsed.lines.reduce((s, l) => s + (l.estimateMin ?? 0), 0);
  const canSubmit = count > 0 && errors.length === 0;

  async function submit() {
    if (!canSubmit || create.isPending) return;
    try {
      await create.mutateAsync(
        parsed.lines.map((l) => ({
          title: l.title,
          estimateMin: l.estimateMin,
          notes: l.notes,
          categoryId: task.categoryId,
          parentId: task.id,
        })),
      );
      onDone();
    } catch {
      // Said inline below.
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      {/* Its opener unmounts on a parent ("Add parts…" gives way to the form): focus starts here. */}
      <Textarea
        label="Add parts — one per line: title | ~minutes"
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'read the paper | ~45\ndraft | ~60'}
      />
      {errors.length > 0 && (
        // status, not alert: it updates as you type, so it mustn't interrupt on every keystroke.
        <div role="status" className="flex flex-col gap-0.5">
          {errors.map((e) => (
            <Text key={e} size="xs" tone="danger">
              {e}
            </Text>
          ))}
        </div>
      )}
      <Text size="xs" tone="muted">
        {count === 0
          ? 'Each part is a task of its own — planned, worked and measured on its own.'
          : `${count} ${count === 1 ? 'part' : 'parts'}${est > 0 ? ` · est ${fmtDuration(est)}` : ''}${
              !isParent && task.status === 'planned'
                ? ' · the first takes its spot on the plan'
                : ''
            }`}
      </Text>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit}
          aria-disabled={create.isPending}
          onClick={submit}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Add parts
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {create.isError && (
        <div role="alert">
          <Text size="xs" tone="danger">
            {create.error instanceof Error ? create.error.message : 'Couldn’t add the parts.'} Try
            again.
          </Text>
        </div>
      )}
    </div>
  );
}
