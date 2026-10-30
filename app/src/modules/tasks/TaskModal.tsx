import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { TaskEditor } from './editor/TaskEditor';
import type { TaskEditorIntent } from './editor/TaskEditor';
import type { EditState } from './editor/TaskDetailsForm';
import { TaskModalContext, useOpenTask } from './task-modal-context';
import type { OpenTask } from './task-modal-context';

// What the user asked to leave for: another task (opened from inside this one), or out.
type Exit = Parameters<OpenTask> | 'close';

// Wraps the Modal primitive around the task editor. Owns what the editor body shouldn't:
//   - initial focus: the dialog itself (initialFocus="dialog"), so a title tap focuses no field and
//     raises no iPhone keyboard; finish/scope then move it to Actual/Estimate (effect lives HERE, a
//     parent of Modal, so it runs AFTER Modal's showModal() — child effects fire first, the ordering
//     BulkAddDialog relies on);
//   - the unsaved-changes guard: Esc / backdrop / Close all route through `requestClose`, which pops a
//     confirm dialog when the editor is dirty (details, or text typed into Add parts / Split). An exit
//     asked for mid-save waits for the write, and is dropped if it fails (the failure stays shown).
//     Mark done and Drop call `onClose` directly
//     (nothing unsaved), so they never prompt; Delete closes via TaskModalHost once the task leaves
//     the list; Save keeps the modal open;
//   - resetting that guard state when the modal closes (the editor also unmounts, reseeding its form);
//   - the same guard on opening another task from inside this one (a parent's name, a part's row): its
//     unsaved edits are asked about first, and the editor remounts per task, so one task's edits can
//     never show on — or be saved onto — another. The dialog scrolls back to the top on a switch.
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
  const [state, setState] = useState<EditState>('clean');
  const [confirming, setConfirming] = useState(false);
  // An exit held back: by the confirm (dirty), or until a save in flight lands (saving).
  const [pending, setPending] = useState<Exit | null>(null);
  const openTask = useOpenTask();
  const run = useCallback(
    (next: Exit) => (next === 'close' ? onClose() : openTask?.(...next)),
    [onClose, openTask],
  );
  const exit = useCallback(
    (next: Exit) => {
      if (state === 'clean') return run(next);
      setPending(next);
      if (state === 'dirty') setConfirming(true);
    },
    [state, run],
  );
  const guardedOpen = useCallback<OpenTask>((...next) => exit(next), [exit]);

  // The save landed: clean → go on. Still dirty → it failed (or more was typed): stay, with the
  // failure showing — the next exit asks as usual.
  useEffect(() => {
    if (!pending || confirming || state === 'saving') return;
    setPending(null);
    if (state === 'clean') run(pending);
  }, [state, pending, confirming, run]);

  useEffect(() => {
    if (!open) return;
    if (intent === 'finish') actualRef.current?.focus();
    else if (intent === 'scope') estimateRef.current?.focus();
  }, [open, intent]);

  useEffect(() => {
    if (!open) {
      setState('clean');
      setConfirming(false);
      setPending(null);
    }
  }, [open]);

  const requestClose = () => exit('close');
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
        contentKey={task.id}
      >
        {open && (
          <TaskModalContext value={guardedOpen}>
            <TaskEditor
              key={task.id}
              task={task}
              intent={intent}
              onClose={onClose}
              onRequestClose={requestClose}
              onStateChange={setState}
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
                setState('clean');
                setPending(null);
                run(pending ?? 'close');
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
