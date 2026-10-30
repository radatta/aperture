import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { TaskEditor } from './editor/TaskEditor';
import type { TaskEditorIntent } from './editor/TaskEditor';
import { TaskModalContext, useOpenTask } from './task-modal-context';
import type { OpenTask } from './task-modal-context';

// Wraps the Modal primitive around the task editor. Owns three things the editor body shouldn't:
//   - initial focus: the dialog itself (initialFocus="dialog"), so a title tap focuses no field and
//     raises no iPhone keyboard; finish/scope then move it to Actual/Estimate (effect lives HERE, a
//     parent of Modal, so it runs AFTER Modal's showModal() — child effects fire first, the ordering
//     BulkAddDialog relies on);
//   - the unsaved-changes guard: Esc / backdrop / Close all route through `requestClose`, which pops a
//     confirm dialog when the details form is dirty. Mark done and Drop call `onClose` directly
//     (nothing unsaved), so they never prompt; Delete closes via TaskModalHost once the task leaves
//     the list; Save keeps the modal open;
//   - resetting that guard state when the modal closes (the editor also unmounts, reseeding its form);
//   - the same guard on opening another task from inside this one (a parent's name, a part's row): its
//     unsaved edits are asked about first, and the editor remounts per task, so one task's edits can
//     never show on — or be saved onto — another.
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
  // Another task asked for while this one has unsaved edits — opened only once they're discarded.
  const [pending, setPending] = useState<Parameters<OpenTask> | null>(null);
  const openTask = useOpenTask();
  const guardedOpen = useCallback<OpenTask>(
    (...next) => {
      if (!dirty) return openTask?.(...next);
      setPending(next);
      setConfirming(true);
    },
    [dirty, openTask],
  );

  useEffect(() => {
    if (!open) return;
    if (intent === 'finish') actualRef.current?.focus();
    else if (intent === 'scope') estimateRef.current?.focus();
  }, [open, intent]);

  useEffect(() => {
    if (!open) {
      setDirty(false);
      setConfirming(false);
      setPending(null);
    }
  }, [open]);

  const requestClose = () => {
    setPending(null); // a close, not a switch
    if (dirty) setConfirming(true);
    else onClose();
  };
  const keepEditing = () => {
    setConfirming(false);
    setPending(null);
  };

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        closeOnBackdrop
        initialFocus="dialog"
        label={`Task: ${task.title}`}
      >
        {open && (
          <TaskModalContext value={guardedOpen}>
            <TaskEditor
              key={task.id}
              task={task}
              intent={intent}
              onClose={onClose}
              onRequestClose={requestClose}
              onDirtyChange={setDirty}
              estimateRef={estimateRef}
              actualRef={actualRef}
            />
          </TaskModalContext>
        )}
      </Modal>

      {/* Stacks on top of the editor (a second native dialog → higher in the top layer). */}
      <Modal open={confirming} onClose={keepEditing} label="Discard unsaved changes?">
        <div className="flex flex-col gap-3">
          <Text as="h2" size="lg" weight="semibold">
            Discard changes?
          </Text>
          <Text size="sm" tone="muted">
            You’ve edited this task but haven’t saved. Leaving now loses those edits.
          </Text>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button
              variant="gold"
              onClick={() => {
                setConfirming(false);
                if (!pending) return onClose();
                setDirty(false);
                setPending(null);
                openTask?.(...pending);
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
