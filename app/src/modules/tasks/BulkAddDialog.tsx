import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtMonthDayYear, parseBulkTasks, toCreateInputs } from '@aperture/shared';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { Button } from '../../components/Button';
import { Textarea } from '../../components/Textarea';
import { NoteIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';
import { useActiveCategories } from '../../data/hooks/useCategories';
import { useAllTasks, useCreateTasks } from '../../data/hooks/useTasks';

const PLACEHOLDER = `email coach
finish 214 pset | ~90 #"Deep Work" due:2026-09-25
book flight | due:2026-10-02
read ch. 4 | notes:"q6: use the lemma\\nhttps://example.edu/pset4"`;

// Bulk add — the plan-pass surface (PRODUCT §2: batch entry is the morning plan, not capture). One line
// = one backlog task; ' | ' separates the title from inline tokens (~minutes, #category, due:YYYY-MM-DD,
// notes:"…").
// The preview parses live: red errors gate submit, gold warnings don't (the task is created anyway). The
// grammar is meant to be GENERATED (by Claude), so it's strict — operator reference: docs/areas/tasks/bulk-add.md.
export function BulkAddDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const { data: categories = [], isSuccess: categoriesLoaded } = useActiveCategories();
  const { data: tasks = [] } = useAllTasks();
  const createTasks = useCreateTasks();
  const [text, setText] = useState('');
  const [failed, setFailed] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Fresh draft each open (cancel/Escape drops it), clear any prior failure, take focus. Modal's own
  // effect (showModal) runs first — it's the child — so focusing the field here wins over the dialog.
  useEffect(() => {
    if (!open) return;
    setText('');
    setFailed(false);
    areaRef.current?.focus();
  }, [open]);

  const existingTitles = useMemo(
    () =>
      new Set(
        tasks
          .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
          .map((t) => t.title.toLowerCase()),
      ),
    [tasks],
  );
  const catRefs = useMemo(
    () => categories.map((c) => ({ id: c.id, label: c.label })),
    [categories],
  );
  const parse = useMemo(
    () => parseBulkTasks(text, catRefs, existingTitles),
    [text, catRefs, existingTitles],
  );
  const n = parse.lines.length;
  // If a paste references categories but the list hasn't loaded yet (or errored), a real #label would
  // silently miss — the parser sees an empty set → a gold "no category" warning → an uncategorised task.
  // Block submit until categories are in, but only when it actually matters (title-only pastes still go).
  const awaitingCategories = !categoriesLoaded && parse.lines.some((l) => l.categoryLabel !== null);
  const blocked = !parse.canSubmit || createTasks.isPending || awaitingCategories;

  const submit = () => {
    if (blocked) return;
    const inputs = toCreateInputs(parse);
    setFailed(false);
    createTasks.mutate(inputs, {
      onSuccess: () => {
        onAdded(inputs.length);
        onClose();
      },
      // Keep the dialog + text; on refetch the "already exists" warnings mark exactly what did land.
      onError: () => setFailed(true),
    });
  };

  const summary = parse.canSubmit
    ? `${n} task${n === 1 ? '' : 's'} ready`
    : parse.errorCount > 0
      ? `${parse.errorCount} line${parse.errorCount === 1 ? '' : 's'} to fix`
      : 'paste one task per line';

  return (
    <Modal open={open} onClose={onClose} label="Bulk add tasks">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Text as="h2" size="lg" weight="semibold">
            Bulk add tasks
          </Text>
          <Text size="sm" tone="muted">
            One line each — <code>title | ~30 #Admin due:2026-09-25</code> (estimate, category, due
            date).
          </Text>
          {categories.length > 0 && (
            <Text size="xs" tone="subtle">
              Categories: {categories.map((c) => c.label).join(', ')}
            </Text>
          )}
        </div>

        <Textarea
          ref={areaRef}
          rows={8}
          value={text}
          placeholder={PLACEHOLDER}
          aria-label="Tasks, one per line"
          aria-describedby="bulk-add-summary"
          onChange={(e) => setText(e.target.value)}
          className="font-mono text-sm"
        />

        {n > 0 && (
          <ul className="flex max-h-64 flex-col gap-1.5 overflow-auto">
            {parse.lines.map((l) => (
              <li key={l.line} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Text size="xs" tone="subtle" tabular>
                    {l.line}
                  </Text>
                  <Text size="sm" tone={l.errors.length ? 'muted' : 'ink'}>
                    {l.title || '(no title)'}
                  </Text>
                  {l.estimateMin !== null && (
                    <Text size="xs" tone="teal">
                      {fmtDuration(l.estimateMin)}
                    </Text>
                  )}
                  {l.categoryLabel !== null && (
                    <Text size="xs" tone={l.categoryId ? 'teal' : 'muted'}>
                      #{l.categoryLabel}
                    </Text>
                  )}
                  {l.dueDay !== null && (
                    <Text size="xs" tone="teal">
                      {fmtMonthDayYear(l.dueDay)}
                    </Text>
                  )}
                  {l.notes !== null && (
                    <Text size="xs" tone="teal" className="inline-flex items-center gap-0.5">
                      <NoteIcon size={11} />
                      notes
                    </Text>
                  )}
                </div>
                {l.errors.map((e, i) => (
                  <Text key={`e${i}`} size="xs" tone="danger">
                    {e}
                  </Text>
                ))}
                {l.warnings.map((w, i) => (
                  <Text key={`w${i}`} size="xs" tone="gold">
                    {w}
                  </Text>
                ))}
              </li>
            ))}
          </ul>
        )}

        {failed && (
          <Text size="sm" tone="danger">
            Couldn’t save — your text is intact. Any that landed show as “already exists”; try
            again.
          </Text>
        )}

        {awaitingCategories && (
          <Text size="sm" tone="muted">
            Loading categories… hold on so your #labels resolve.
          </Text>
        )}

        <div className="flex items-center justify-between gap-3">
          <Text id="bulk-add-summary" size="sm" tone={parse.errorCount > 0 ? 'danger' : 'muted'}>
            {summary}
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={blocked}>
              Add {n} task{n === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
