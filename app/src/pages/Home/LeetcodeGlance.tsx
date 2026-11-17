import { Link } from 'react-router';
import { Text } from '../../components/Text';
import { useCoachToday } from '../../data/hooks/useCoach';
import { useSettings } from '../../data/hooks/useSettings';
import { coachGlance } from '../Recruiting/recruitingHelpers';

// LeetCode on the morning home is one line, not a card — FinanceGlance's posture: the coach's day
// ("LeetCode · 4 today · +1 re-solve due"), linking to the Today card. Read only once a LeetCode roll is linked,
// so a day without LeetCode costs no read and shows nothing.
export function LeetcodeGlance() {
  const { data: settings } = useSettings();
  const linked = !!settings?.leetcodeRollId;
  const { data: today, isError, pickStart } = useCoachToday({ enabled: linked });
  if (!linked) return null;
  // A failed read is one quiet-but-visible line, never silence.
  if (isError && !today)
    return (
      <Link to="/recruiting" className="flex items-center justify-between gap-2 px-1 text-sm">
        <Text size="sm" tone="danger">
          LeetCode · couldn’t load today’s plan
        </Text>
        <Text size="sm" tone="muted" aria-hidden>
          Today →
        </Text>
      </Link>
    );
  if (!today) return null;
  return (
    <Link to="/recruiting" className="flex items-center justify-between gap-2 px-1 text-sm">
      <Text size="sm" tone="muted" tabular className="min-w-0">
        {coachGlance(today, pickStart.isError)}
      </Text>
      <Text size="sm" tone="muted" aria-hidden className="shrink-0 whitespace-nowrap">
        Today →
      </Text>
    </Link>
  );
}
