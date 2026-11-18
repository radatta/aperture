import { useId, useState } from 'react';
import { MOCK_KIND_NAMES, MOCK_KINDS, MOCK_NOTES_MAX, MOCK_PARTNER_MAX } from '@aperture/shared';
import type { MockBrief, MockKind, MockScore } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { ModeToggle } from '../../components/ModeToggle';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { Textarea } from '../../components/Textarea';
import { useUpsertMock } from '../../data/hooks/useCoach';
import { isTransientRead } from '../../data/retry';

type Status = 'done' | 'planned';
const SCORES = ['1', '2', '3', '4'] as const;

// Log a mock interview, or plan one (docs/areas/recruiting/coach.md → Mocks). `mock` is a planned one being
// logged ("Log it"): it saves onto that row as done. A refused or failed save keeps every field and says why.
export function MockForm({
  today,
  mock,
  onSaved,
  onCancel,
}: {
  today: string; // the user's day, from the plan
  mock?: MockBrief | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const upsert = useUpsertMock();
  const [status, setStatus] = useState<Status>('done');
  const [day, setDay] = useState(mock && mock.day <= today ? mock.day : today);
  const [kind, setKind] = useState<MockKind>(mock?.kind ?? 'human');
  const [partner, setPartner] = useState(mock?.partner ?? '');
  const [code, setCode] = useState<MockScore | null>(null);
  const [solve, setSolve] = useState<MockScore | null>(null);
  const [communicate, setCommunicate] = useState<MockScore | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = status === 'done';

  async function save() {
    if (upsert.isPending) return;
    setError(null);
    if (done && (!code || !solve))
      return setError('Add the Code and Solve scores (1 to 4) to log a done mock.');
    if (!day) return setError('Pick the day.');
    try {
      await upsert.mutateAsync({
        ...(mock ? { id: mock.id } : {}),
        day,
        status,
        kind,
        partner: partner.trim() || null,
        scores:
          done && code && solve ? { code, solve, ...(communicate ? { communicate } : {}) } : null,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(
        isTransientRead(e)
          ? 'Couldn’t confirm the save — it may have saved; the card shows what stands.'
          : (e as Error).message || 'Couldn’t save the mock — try again.',
      );
    }
  }

  const score = (
    label: string,
    value: MockScore | null,
    set: (v: MockScore | null) => void,
    optional = false,
  ) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text id={`${id}-${label}`} size="sm" tone="muted">
        {label}
        {optional ? ' (optional)' : ''}
      </Text>
      <ModeToggle
        aria-labelledby={`${id}-${label}`}
        options={SCORES.map((s) => ({ value: s, label: s, title: `${label} ${s} of 4` }))}
        value={value ? String(value) : ''}
        // An optional score clears on a second tap.
        onChange={(v) => set(optional && Number(v) === value ? null : (Number(v) as MockScore))}
      />
    </div>
  );

  return (
    <form
      aria-label={mock ? 'Log the planned mock' : 'Log a mock'}
      className="flex flex-col gap-3 rounded-xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!mock && (
        <ModeToggle
          aria-labelledby={`${id}-status`}
          options={[
            { value: 'done', label: 'Done' },
            { value: 'planned', label: 'Planned' },
          ]}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setError(null);
          }}
          className="self-start"
        />
      )}
      <span id={`${id}-status`} className="sr-only">
        Mock status
      </span>
      <Field
        type="date"
        label="Day"
        value={day}
        max={done ? today : undefined}
        min={done ? undefined : today}
        onChange={(e) => setDay(e.target.value)}
        className="text-base"
      />
      <Select
        label="Kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as MockKind)}
        options={MOCK_KINDS.map((k) => ({ value: k, label: MOCK_KIND_NAMES[k] }))}
        className="text-base"
      />
      <Field
        label="Who ran it (optional)"
        value={partner}
        maxLength={MOCK_PARTNER_MAX}
        onChange={(e) => setPartner(e.target.value)}
        className="text-base"
      />
      {done && (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Scores, 1 to 4</legend>
          {score('Code', code, setCode)}
          {score('Solve', solve, setSolve)}
          {score('Communication', communicate, setCommunicate, true)}
        </fieldset>
      )}
      <Textarea
        label="Notes (optional)"
        value={notes}
        rows={2}
        autogrow
        maxLength={MOCK_NOTES_MAX}
        onChange={(e) => setNotes(e.target.value)}
        className="text-base"
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" aria-disabled={upsert.isPending || undefined}>
          {upsert.isPending ? 'Saving…' : done ? 'Save mock' : 'Plan mock'}
        </Button>
        <Button type="button" variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
