import { useEffect, useRef } from 'react';
import type { Task } from '@aperture/shared';
import { Modal } from '../../components/Modal';
import { TaskEditor } from './editor/TaskEditor';
import type { TaskEditorIntent } from './editor/TaskEditor';

// Wraps the Modal primitive around the task editor and owns the field-focus that finish/scope intents
// need. The focus effect lives HERE, a parent of Modal, so it runs AFTER Modal's showModal() effect
// (child effects fire first) — the same ordering BulkAddDialog relies on. TaskEditor mounts only while
// open, so its form state reseeds from the current task on every open.
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

  useEffect(() => {
    if (!open) return;
    if (intent === 'finish') actualRef.current?.focus();
    else if (intent === 'scope') estimateRef.current?.focus();
  }, [open, intent]);

  return (
    <Modal open={open} onClose={onClose} label={`Task: ${task.title}`}>
      {open && (
        <TaskEditor
          task={task}
          intent={intent}
          onClose={onClose}
          estimateRef={estimateRef}
          actualRef={actualRef}
        />
      )}
    </Modal>
  );
}
