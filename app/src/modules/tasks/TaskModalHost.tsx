import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { useDisclosure } from '../../lib/useDisclosure';
import { useAllTasks } from '../../data/hooks/useTasks';
import { TaskModal } from './TaskModal';
import type { TaskEditorIntent } from './editor/TaskEditor';
import { TaskModalContext } from './task-modal-context';
import type { OpenTask } from './task-modal-context';

// One task modal for the page, not one per row. Save keeps the modal open, and a save can move its
// row out of the list (a due date moves Backlog → Week, a rename leaves a search) — a row-owned modal
// would vanish with the row. The task is read live from the tasks query by id; the copy the row
// passed covers the first render. Focus returns to the row's title while the row exists, else to the
// list area (never <body>). A task that leaves the list while open (Delete, or a delete elsewhere)
// closes the modal.
export function TaskModalHost({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const modal = useDisclosure();
  const { data: tasks } = useAllTasks();
  const fallbackRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ task: Task; intent: TaskEditorIntent } | null>(null);
  const returning = useRef(false);
  const seenLive = useRef(false);

  const { triggerRef, onOpen, onClose } = modal;
  const openTask = useCallback<OpenTask>(
    (task, intent, trigger) => {
      triggerRef.current = trigger;
      returning.current = false;
      seenLive.current = false;
      setTarget({ task, intent });
      onOpen();
    },
    [triggerRef, onOpen],
  );
  const close = useCallback(() => {
    returning.current = true;
    onClose();
  }, [onClose]);

  const live = target ? tasks?.find((t) => t.id === target.task.id) : undefined;
  const task = live ?? target?.task;

  // Gone from the list after being in it → deleted (here or elsewhere): close. The "seen" check keeps
  // a host that never had the task in its list (a standalone row) from closing it on sight.
  useEffect(() => {
    if (!modal.open) return;
    if (live) seenLive.current = true;
    else if (seenLive.current) close();
  }, [modal.open, live, close]);

  // After a close, useDisclosure returns focus to the title button. If that row has left the list —
  // now, or on the refetch still coming — focus would sit on <body>; move it to the list area. Keyed
  // off data changes rather than frames, and never overrides focus the user has since moved.
  useEffect(() => {
    if (modal.open || !returning.current) return;
    const trigger = triggerRef.current;
    if (trigger?.isConnected && document.activeElement === trigger) return; // row may still leave
    returning.current = false;
    if (!trigger?.isConnected && document.activeElement === document.body)
      fallbackRef.current?.focus({ preventScroll: true });
  }, [modal.open, tasks, triggerRef]);

  return (
    <TaskModalContext value={openTask}>
      <div ref={fallbackRef} tabIndex={-1} className={cx('outline-none', className)}>
        {children}
      </div>
      {task && target && (
        <TaskModal task={task} open={modal.open} intent={target.intent} onClose={close} />
      )}
    </TaskModalContext>
  );
}
