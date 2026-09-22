import type { Ref } from 'react';
import type { Task } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';

// The task title as the trigger that opens the editor. Truncates in the row, but its accessible name
// is the FULL title (so it's findable and a screen reader gets the whole thing); the modal shows it
// unclipped. Ref-forwarding so useDisclosure can return focus here on close. The seam other truncated
// title spots (Home, PlanSection) can adopt later.
export function TaskTitleButton({
  task,
  onOpen,
  ref,
  weight = 'medium',
  className,
}: {
  task: Task;
  onOpen: () => void;
  ref?: Ref<HTMLButtonElement>;
  weight?: 'normal' | 'medium' | 'semibold';
  className?: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      title={task.title}
      className={cx('min-w-0 max-w-full text-left hover:underline', className)}
    >
      <Text as="span" weight={weight} className="block truncate">
        {task.title}
      </Text>
    </button>
  );
}
