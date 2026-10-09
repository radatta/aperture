import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { returnFocus, useDisclosure } from '../../lib/useDisclosure';
import { useAllTasks } from '../../data/hooks/useTasks';
import { TaskModal } from './TaskModal';
import type { TaskEditorIntent } from './editor/TaskEditor';
import { TaskModalContext } from './task-modal-context';
import type { OpenTask } from './task-modal-context';

// One task modal for the page, not one per row. Save keeps the modal open, and a save can move its
// row out of the list (a due date moves Backlog → Week, a rename leaves a search) — a row-owned modal
// would vanish with the row. The task is read live from the tasks query by id; the copy the row
// passed covers the first render. Focus returns to the row's title (found again by task id if the row
// re-rendered, e.g. into another group), else to the list area — never <body>. A task that leaves the list while open (Delete, or a delete elsewhere)
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
  // Once the task has been seen live, the last live copy (not the one passed at open) stands in when it
  // disappears — so a delete never paints one frame of pre-save values before the modal closes.
  const [lastLive, setLastLive] = useState<Task | undefined>(undefined);
  if (live && live !== lastLive) setLastLive(live); // derived state, updated during render
  const task = live ?? (lastLive?.id === target?.task.id ? lastLive : undefined) ?? target?.task;

  // Gone from the list after being in it → deleted (here or elsewhere): close. The "seen" check keeps
  // a host that never had the task in its list (a standalone row) from closing it on sight.
  useEffect(() => {
    if (!modal.open) return;
    if (live) seenLive.current = true;
    else if (seenLive.current) close();
  }, [modal.open, live, close]);

  // After a close, useDisclosure returns focus to the title button. That exact node can be gone — the
  // row left the list, or moved to another group and re-rendered — now, or on the refetch still
  // coming. Then focus would sit on <body>: find the row's title again by task id, else the list area.
  // Keyed off data and DOM changes rather than frames, and never overrides focus the user has since
  // moved.
  const targetId = target?.task.id;
  useEffect(() => {
    if (modal.open || !returning.current) return;
    const root = fallbackRef.current;
    const recover = () => {
      const again = targetId
        ? root?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(targetId)}"]`)
        : null;
      if (again) returnFocus(again);
      else root?.focus({ preventScroll: true });
    };
    const trigger = triggerRef.current;
    if (trigger?.isConnected && document.activeElement === trigger) {
      // The row may still move. The list can re-render after this host has the new data (Today's
      // lens subscribes on its own, so a Done row leaves a render later), so watch the DOM as well,
      // but only until the user's next tap or key: after that, a row leaving is their doing.
      if (!root) return;
      const stop = () => {
        watch.disconnect();
        document.removeEventListener('pointerdown', stop, true);
        document.removeEventListener('keydown', stop, true);
        returning.current = false;
      };
      const watch = new MutationObserver(() => {
        if (trigger.isConnected) return;
        stop();
        if (document.activeElement === document.body) recover();
      });
      watch.observe(root, { childList: true, subtree: true });
      document.addEventListener('pointerdown', stop, true);
      document.addEventListener('keydown', stop, true);
      return () => {
        watch.disconnect();
        document.removeEventListener('pointerdown', stop, true);
        document.removeEventListener('keydown', stop, true);
      };
    }
    returning.current = false;
    if (trigger?.isConnected || document.activeElement !== document.body) return;
    recover();
  }, [modal.open, tasks, triggerRef, targetId]);

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
