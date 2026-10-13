import { fmtClock12, fmtDueDay, fmtMonthDayYear } from '@aperture/shared';
import type { BulkLine } from '@aperture/shared';
import { Text } from '../../components/Text';
import { NoteIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';

// The parsed-token preview for one line of the bulk grammar — shared by Bulk add and capture's Task
// mode so the grammar reads back one way. An unmatched #label is muted (it'll land uncategorised).
// `today` switches the due chip to relative phrasing ("due tomorrow 4pm") — quick add's preview, where you
// typed "tmw" and the absolute date would make you work out whether it read you right.
export function TaskTokenChips({ line, today }: { line: BulkLine; today?: string }) {
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
          {today
            ? fmtDueDay(line.dueDay, today, line.dueTime)
            : `${fmtMonthDayYear(line.dueDay)}${line.dueTime !== null ? ` ${fmtClock12(line.dueTime)}` : ''}`}
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
