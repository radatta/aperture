import { useEffect, useRef, useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { TaskEditor } from './editor/TaskEditor';
import type { TaskEditorIntent } from './editor/TaskEditor';

// Wraps the Modal primitive around the task editor. Owns three things the editor body shouldn't:
//   - the field-focus for finish/scope intents (effect lives HERE, a parent of Modal, so it runs
//     AFTER Modal's showModal() — child effects fire first, the ordering BulkAddDialog relies on);
//   - the unsaved-changes guard: Esc / backdrop / Close all route through `requestClose`, which pops a
//     confirm dialog when the details form is dirty. A real Save/Drop/Delete calls `onClose` directly
//     (nothing unsaved), so it never prompts;
//   - resetting that guard state when the modal closes (the editor also unmounts, reseeding its form).
export function TaskModal({
  task,
  open,
  intent,
  onClose,
}: {
  task: Task;
  open: boolean;
  intent: TaskEditorIntent;
  onClose: () => void;
}) {
  const estimateRef = useRef<HTMLInputElement>(null);
  const actualRef = useRef<HTMLInputElement>(null);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (intent === 'finish') actualRef.current?.focus();
    else if (intent === 'scope') estimateRef.current?.focus();
  }, [open, intent]);

  useEffect(() => {
    if (!open) {
      setDirty(false);
      setConfirming(false);
    }
  }, [open]);

  const requestClose = () => (dirty ? setConfirming(true) : onClose());

  return (
    <>
      <Modal open={open} onClose={requestClose} closeOnBackdrop label={`Task: ${task.title}`}>
        {open && (
          <TaskEditor
            task={task}
            intent={intent}
            onClose={onClose}
            onRequestClose={requestClose}
            onDirtyChange={setDirty}
            estimateRef={estimateRef}
            actualRef={actualRef}
          />
        )}
      </Modal>

      {/* Stacks on top of the editor (a second native dialog → higher in the top layer). */}
      <Modal open={confirming} onClose={() => setConfirming(false)} label="Discard unsaved changes?">
        <div className="flex flex-col gap-3">
          <Text as="h2" size="lg" weight="semibold">
            Discard changes?
          </Text>
          <Text size="sm" tone="muted">
            You’ve edited this task but haven’t saved. Leaving now loses those edits.
          </Text>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep editing
            </Button>
            <Button
              variant="gold"
              onClick={() => {
                setConfirming(false);
                onClose();
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
