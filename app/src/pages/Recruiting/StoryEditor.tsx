import { useState } from 'react';
import { COMPETENCY_TAGS } from '@aperture/shared';
import type { CompetencyTag, Story } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Text } from '../../components/Text';
import { Textarea } from '../../components/Textarea';
import { cx } from '../../lib/cx';

export interface StoryFields {
  title: string;
  competencyTags: CompetencyTag[];
  situation: string;
  action: string;
  result: string;
}

// The create/edit form for a story — structured-at-entry is deliberate here (unlike capture elsewhere).
// Only the title is required; Situation/Action/Result may be left empty (start ugly, tighten later). No
// Enter-to-submit — the textareas need Enter for newlines. Save is guarded on a blank title and on
// `pending` so a double-click can't double-submit.
export function StoryEditor({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial?: Story;
  pending: boolean;
  onSave: (fields: StoryFields) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [tags, setTags] = useState<CompetencyTag[]>(initial?.competencyTags ?? []);
  const [situation, setSituation] = useState(initial?.situation ?? '');
  const [action, setAction] = useState(initial?.action ?? '');
  const [result, setResult] = useState(initial?.result ?? '');

  const toggleTag = (t: CompetencyTag) =>
    setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  function save() {
    if (!title.trim() || pending) return;
    onSave({ title: title.trim(), competencyTags: tags, situation, action, result });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field
        autoFocus
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Turned around the failing migration…"
      />

      <div className="flex flex-col gap-1.5">
        <Text size="sm" tone="muted">
          Competencies
        </Text>
        <div role="group" aria-label="Competencies" className="flex flex-wrap gap-1.5">
          {COMPETENCY_TAGS.map((t) => {
            const on = tags.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => toggleTag(t)}
                className={cx(
                  'rounded-lg border px-2.5 py-1 text-xs capitalize transition',
                  on
                    ? 'border-teal bg-teal-soft text-ink'
                    : 'border-line text-ink-muted hover:text-ink',
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>

      <Textarea
        label="Situation"
        value={situation}
        onChange={(e) => setSituation(e.target.value)}
        placeholder="The context — what was going on?"
      />
      <Textarea
        label="Action"
        value={action}
        onChange={(e) => setAction(e.target.value)}
        placeholder="What you did, specifically."
      />
      <Textarea
        label="Result"
        value={result}
        onChange={(e) => setResult(e.target.value)}
        placeholder="How it turned out — numbers if you have them."
      />

      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={!title.trim() || pending}>
          {initial ? 'Save' : 'Add story'}
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
