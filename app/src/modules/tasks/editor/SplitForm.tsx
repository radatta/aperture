import { useState } from 'react';
import { canTransitionTask } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { useSplitTask } from '../../../data/hooks/useTasks';

// Scope change = split. Finish the original (done keeps its partial calibration; cancelled excludes
// it) and spawn a fresh backlog follow-up for the remaining work — the locked estimate is never edited.
export function SplitForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const split = useSplitTask();
  const [title, setTitle] = useState(`${task.title} (cont.)`);
  // "Done" is only a legal finish once work has started — the state machine forbids backlog|planned →
  // done. Offering it there threw "Invalid task transition". Gate the option on what's actually legal.
  const canFinishDone = canTransitionTask(task.status, 'done');
  const [finish, setFinish] = useState<'done' | 'cancelled'>(canFinishDone ? 'done' : 'cancelled');
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <Text size="sm" tone="muted">
        Split off the remaining scope into a new backlog task.
      </Text>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Follow-up title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-64"
        />
        {canFinishDone ? (
          <Select
            label="Finish original as"
            value={finish}
            onChange={(e) => setFinish(e.target.value as 'done' | 'cancelled')}
            options={[
              { value: 'done', label: 'Done (keeps calibration)' },
              { value: 'cancelled', label: 'Cancelled (excluded)' },
            ]}
            className="w-52"
          />
        ) : (
          // Not-yet-started tasks can only be cancelled (never "done"); no choice to offer.
          <Text size="sm" tone="muted">
            The original will be cancelled.
          </Text>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!title.trim() || split.isPending}
          onClick={async () => {
            try {
              await split.mutateAsync({
                id: task.id,
                finishStatus: finish,
                followUpTitle: title.trim(),
              });
              onDone();
            } catch {
              // Surfaced inline below — swallow so it isn't an unhandled rejection (which leaked the
              // raw error JSON to the page).
            }
          }}
        >
          Split
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {split.isError && (
        <Text size="xs" tone="danger">
          Couldn&apos;t split this task. Please try again.
        </Text>
      )}
    </div>
  );
}
