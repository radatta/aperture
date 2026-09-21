import { fmtDayHeading, fmtMonthShortDay } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { Text } from '../../components/Text';
import { contactSheet, fmtLastRep } from './rollSheet';

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// A roll's forgiving momentum, rendered. Unlike the Habits grid this is READ-ONLY (no toggle), has no
// "today" ring and no hollow "please check" cell: a gap is just a fainter dot. Binary teal fill — the
// exact count lives in the tooltip + the count-only label, never as a heat gradient (no score energy).
export function ContactSheet({
  reps,
  today,
  name,
}: {
  reps: Map<string, number>;
  today: string;
  name: string;
}) {
  const { rows, total, lastRepDay } = contactSheet(reps, today);
  const caption =
    total === 0
      ? 'No reps yet — pick it for today to start the sheet.'
      : `${total} ${total === 1 ? 'rep' : 'reps'} · last ${fmtLastRep(lastRepDay!, today)}`;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="img"
        aria-label={
          total === 0 ? `${name}: no reps yet` : `${name}: ${total} reps, last ${fmtLastRep(lastRepDay!, today)}`
        }
        className="flex flex-col gap-1"
      >
        <div className="flex gap-1" aria-hidden="true">
          <div className="w-10 shrink-0" />
          {DOW.map((d, i) => (
            <div key={i} className="w-6 text-center">
              <Text size="xs" tone="subtle">
                {d}
              </Text>
            </div>
          ))}
        </div>
        {rows.map((week, wi) => (
          <div key={wi} className="flex items-center gap-1" aria-hidden="true">
            <div className="w-10 shrink-0">
              <Text size="xs" tone="subtle" tabular>
                {wi === rows.length - 1 ? 'now' : fmtMonthShortDay(week[0]!.date)}
              </Text>
            </div>
            {week.map((cell) =>
              cell.future ? (
                // Not drawn — the sheet never shows what it's "waiting for". A spacer keeps columns aligned.
                <div key={cell.date} className="h-6 w-6" />
              ) : (
                <div
                  key={cell.date}
                  title={`${fmtDayHeading(cell.date)}${cell.reps ? ` · ${cell.reps} rep${cell.reps > 1 ? 's' : ''}` : ''}`}
                  className={cx('h-6 w-6 rounded-md', cell.reps > 0 ? 'bg-teal' : 'bg-line')}
                />
              ),
            )}
          </div>
        ))}
      </div>
      <Text size="xs" tone="muted" tabular>
        {caption}
      </Text>
    </div>
  );
}
