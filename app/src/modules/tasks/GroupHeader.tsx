import { Text } from '../../components/Text';
import { ChevronRightIcon } from '../../components/icons';
import { cx } from '../../lib/cx';

// A list group's "Label · N" header. With onToggle it's the collapse button; without, a plain label
// (a narrowing search opens every group, so there's nothing to toggle).
export function GroupHeader({
  label,
  count,
  isOpen,
  onToggle,
}: {
  label: string;
  count: number;
  isOpen: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle) return <GroupLabel label={label} count={count} />;
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      onClick={onToggle}
      className="flex items-center gap-1 self-start text-ink-muted transition hover:text-ink"
    >
      <ChevronRightIcon size={13} className={cx('transition', isOpen && 'rotate-90')} />
      <GroupLabel label={label} count={count} />
    </button>
  );
}

function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
      {label} · {count}
    </Text>
  );
}
