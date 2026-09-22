import { useState } from 'react';
import { repDays, todayKey } from '@aperture/shared';
import type { Roll } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Menu } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';
import { useCategories } from '../../data/hooks/useCategories';
import { useRolls, useUpsertRoll } from '../../data/hooks/useRolls';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { useDisclosure } from '../../lib/useDisclosure';
import { CategoryTag } from '../../modules/tasks/CategoryTag';
import { ContactSheet } from '../../modules/rolls/ContactSheet';
import { RollPicker } from '../../modules/rolls/RollPicker';

// Rolls deep view (PRODUCT §4b): deadline-free ongoing efforts, each with a forgiving momentum contact
// sheet. Pick one for today from the strip up top; it lands on the plan and completing it is the rep.
export function RollsPage() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const dayStart = settings?.dayStartHour ?? 4;

  const { data: rolls = [], isPending, isError } = useRolls();
  const { data: tasks = [] } = useAllTasks();
  const active = rolls.filter((r) => r.active);

  return (
    <div className="flex flex-col gap-5">
      <Text as="h1" size="2xl" weight="semibold">
        Rolls
      </Text>
      <RollPicker />
      <NewRoll />
      <div className="flex flex-col gap-3">
        {active.length === 0 ? (
          <EmptyState pending={isPending} error={isError} title="No rolls yet.">
            Start one with “New roll” — a thing you keep returning to, no deadline. Pick it for a day and
            the sheet fills. A gap is just a gap.
          </EmptyState>
        ) : (
          active.map((roll) => (
            <RollCard
              key={roll.id}
              roll={roll}
              today={today}
              reps={repDays(tasks, roll.id, dayStart)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RollCard({ roll, today, reps }: { roll: Roll; today: string; reps: Map<string, number> }) {
  const upsert = useUpsertRoll();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuItems = [
    { label: 'Edit roll…', onSelect: () => setEditing(true) },
    { label: 'Archive roll…', tone: 'danger' as const, onSelect: () => setConfirming(true) },
  ];
  const archive = () =>
    upsert.mutate({
      id: roll.id,
      name: roll.name,
      categoryId: roll.categoryId,
      estimateMin: roll.estimateMin,
      active: false,
    });

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="order-1 flex min-w-0 flex-1 flex-col gap-1.5">
          <Text weight="medium" className="truncate">
            {roll.name}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryTag categoryId={roll.categoryId} />
            {roll.estimateMin != null && (
              <Text size="xs" tone="muted" tabular>
                ~{fmtDuration(roll.estimateMin)}
              </Text>
            )}
          </div>
        </div>
        <div className="order-2 shrink-0 sm:order-3">
          <Menu label={`More actions for ${roll.name}`} items={menuItems} />
        </div>
        <div className="order-3 w-full shrink-0 sm:order-2 sm:w-auto">
          <ContactSheet reps={reps} today={today} name={roll.name} />
        </div>
      </div>

      {editing && (
        <div className="mt-3 rounded-xl border border-line bg-surface p-3">
          <RollForm roll={roll} onClose={() => setEditing(false)} />
        </div>
      )}

      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Archive ${roll.name}?`}
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
        >
          <Text size="sm" tone="muted">
            Archive “{roll.name}”? It stops showing in the picker. Its reps stay as history.
          </Text>
          <Button autoFocus variant="gold" size="sm" onClick={archive}>
            Archive
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}

// Collapsed create trigger — adding a roll is rare; the page's daily job is the picker + the sheets.
function NewRoll() {
  const { open, triggerRef, onOpen, onClose } = useDisclosure();
  if (!open) {
    return (
      <div>
        <Button ref={triggerRef} variant="ghost" size="sm" onClick={onOpen} className="gap-1.5">
          <PlusIcon size={15} /> New roll
        </Button>
      </div>
    );
  }
  return (
    <Card>
      <RollForm onClose={onClose} />
    </Card>
  );
}

// Shared by create + edit. Estimate is required (B8): a roll carries a default estimate its reps inherit,
// so calibration rides ongoing effort too.
function RollForm({ roll, onClose }: { roll?: Roll; onClose: () => void }) {
  const { data: cats = [] } = useCategories();
  const upsert = useUpsertRoll();
  const [name, setName] = useState(roll?.name ?? '');
  const [estimate, setEstimate] = useState(roll?.estimateMin != null ? String(roll.estimateMin) : '30');
  const [categoryId, setCategoryId] = useState(roll?.categoryId ?? '');
  const valid = name.trim() !== '' && Number(estimate) > 0;

  async function save() {
    // The button is disabled while pending; the Enter path needs the same guard or a fast double-Enter
    // creates two rolls (name only clears after the await).
    if (!valid || upsert.isPending) return;
    await upsert.mutateAsync({
      id: roll?.id,
      name: name.trim(),
      categoryId: categoryId || null,
      estimateMin: Math.max(1, Number(estimate)),
      active: roll?.active ?? true,
    });
    if (!roll) setName('');
    onClose();
  }

  function cancel() {
    if (!roll) setName('');
    onClose();
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        autoFocus
        label={roll ? 'Roll' : 'New roll'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="LeetCode daily, study…"
        className="w-56"
      />
      <Field
        label="Estimate (min)"
        type="number"
        min={1}
        inputMode="numeric"
        value={estimate}
        onChange={(e) => setEstimate(e.target.value)}
        className="w-32"
      />
      <Select
        label="Category"
        placeholder="Uncategorized"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        options={cats.map((c) => ({ value: c.id, label: c.label }))}
        className="w-40"
      />
      <Button size="sm" onClick={save} disabled={!valid || upsert.isPending}>
        {roll ? 'Save' : 'Add roll'}
      </Button>
      <Button variant="quiet" size="sm" onClick={cancel}>
        Cancel
      </Button>
    </div>
  );
}
