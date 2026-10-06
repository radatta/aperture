import { fmtClock12, fmtMonthDayYear } from '@aperture/shared';
import type { BulkLine } from '@aperture/shared';
import { Text } from '../../components/Text';
import { NoteIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';

// The parsed-token preview for one line of the bulk grammar — shared by Bulk add and capture's Task
// mode so the grammar reads back one way. An unmatched #label is muted (it'll land uncategorised).
export function TaskTokenChips({ line }: { line: BulkLine }) {
  return (
    <>
      {line.estimateMin !== null && (
        <Text size="xs" tone="teal">
          {fmtDuration(line.estimateMin)}
        </Text>
      )}
      {line.categoryLabel !== null && (
        <Text size="xs" tone={line.categoryId ? 'teal' : 'muted'}>
          #{line.categoryLabel}
        </Text>
      )}
      {line.dueDay !== null && (
        <Text size="xs" tone="teal">
          {fmtMonthDayYear(line.dueDay)}
          {line.dueTime !== null && ` ${fmtClock12(line.dueTime)}`}
        </Text>
      )}
      {line.notes !== null && (
        <Text size="xs" tone="teal" className="inline-flex items-center gap-0.5">
          <NoteIcon size={11} />
          notes
        </Text>
      )}
    </>
  );
}
