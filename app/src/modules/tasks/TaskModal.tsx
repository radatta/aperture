import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { TaskEditor } from './editor/TaskEditor';
import type { TaskEditorIntent } from './editor/TaskEditor';
import { editState } from './editor/editState';
import type { EditSlots } from './editor/editState';
import { TaskModalContext, useOpenTask } from './task-modal-context';
import type { OpenTask } from './task-modal-context';

// What the user asked to leave: out, another task, or (the editor's section buttons) the open reveal.
// `of` says whose edits stand in the way — all of the editor's, or the reveal's alone: the details form
// stays mounted across a section swap, so its edits aren't at risk and mustn't prompt.
type Exit = { go: () => void; of: 'editor' | 'reveal' };

// Wraps the Modal primitive around the task editor. Owns what the editor body shouldn't:
//   - initial focus: the dialog itself (initialFocus="dialog"), so a title tap focuses no field and
//     raises no iPhone keyboard; finish/scope then move it to Actual/Estimate (effect lives HERE, a
//     parent of Modal, so it runs AFTER Modal's showModal() — child effects fire first, the ordering
//     BulkAddDialog relies on);
//   - the unsaved-changes guard: every way out — Esc / backdrop / Close, opening another task from
//     inside this one (a parent's name, a part's row), and the close after Mark done, Drop or a done
//     split — goes through `exit`. A save in flight is waited for (and the exit dropped if it fails —
//     the failure stays shown); unsaved edits are asked about first. After a finish it waits for the
//     task to read as finished, so fields locked by then (due, estimate) no longer count. The editor's
//     section buttons use the same confirm for unsent Add parts / Split text. Delete closes via
//     TaskModalHost once the task leaves the list; Save keeps the modal open;
//   - resetting that guard state when the modal closes (the editor also unmounts, reseeding its form);
//   - one task per editor: it remounts per task, so one task's edits can never show on — or be saved
//     onto — another, and the dialog scrolls back to the top on a switch.
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
  // The forms write their slots (editState.ts); the tick re-renders this when one changes.
  const [editTick, changed] = useReducer((n: number) => n + 1, 0);
  const [edits] = useState<EditSlots>(() => ({ details: 'clean', reveal: 'clean', changed }));
  const [confirming, setConfirming] = useState(false);
  // An exit held back: by the confirm (dirty), or until a save in flight lands (saving).
  const [pending, setPending] = useState<Exit | null>(null);
  const [discarded, setDiscarded] = useState<Exit | null>(null);
  const [finished, setFinished] = useState(false);
  const openTask = useOpenTask();

  const standing = useCallback(
    (x: Exit) => (x.of === 'reveal' ? edits.reveal : editState(edits)),
    [edits],
  );
  const exit = useCallback(
    (next: Exit) => {
      const s = standing(next);
      if (s === 'clean') return next.go();
      setPending(next);
      if (s === 'dirty') setConfirming(true);
    },
    [standing],
  );
  const requestClose = useCallback(() => exit({ go: onClose, of: 'editor' }), [exit, onClose]);
  const guardedOpen = useCallback<OpenTask>(
    (...next) => exit({ go: () => openTask?.(...next), of: 'editor' }),
    [exit, openTask],
  );
  const leaveReveal = useCallback((go: () => void) => exit({ go, of: 'reveal' }), [exit]);

  // The save landed: clean → go on. Still dirty → it failed (or more was typed): stay, with the
  // failure showing — the next exit asks as usual.
  useEffect(() => {
    if (!pending || confirming || standing(pending) === 'saving') return;
    setPending(null);
    if (standing(pending) === 'clean') pending.go();
  }, [editTick, pending, confirming, standing]);

  // Finished here (Mark done, Drop, a done split): out through the guard — once the task reads as
  // finished, so a due date or estimate typed before (locked now, never saveable) no longer counts,
  // while a title or note still does, and a save in flight is waited for.
  const terminal = task.status === 'done' || task.status === 'cancelled';
  useEffect(() => {
    if (!finished || !terminal) return;
    setFinished(false);
    requestClose();
  }, [finished, terminal, requestClose]);

  // Discard runs the exit a commit after the confirm has closed, not in the same one: the new content's
  // focus (the switched-to task's dialog, a reveal's autofocused field) would otherwise be placed while
  // the confirm still sits on top — the dialog beneath a modal is inert — and end on <body>.
  useEffect(() => {
    if (!discarded) return;
    setDiscarded(null);
    discarded.go();
  }, [discarded]);

  useEffect(() => {
    if (!open) return;
    if (intent === 'finish') actualRef.current?.focus();
    else if (intent === 'scope') estimateRef.current?.focus();
  }, [open, intent]);

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      setPending(null);
      setDiscarded(null);
      setFinished(false);
    }
  }, [open]);

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
              edits={edits}
              onFinished={() => setFinished(true)}
              onRequestClose={requestClose}
              onLeaveReveal={leaveReveal}
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
            {pending?.of === 'reveal'
              ? 'What you typed hasn’t been added yet. Switching sections loses it.'
              : 'You’ve edited this task but haven’t saved. Leaving now loses those edits.'}
          </Text>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button
              variant="gold"
              onClick={() => {
                setConfirming(false);
                setPending(null);
                setDiscarded(pending ?? { go: onClose, of: 'editor' });
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
