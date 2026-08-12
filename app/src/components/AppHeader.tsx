import { Link } from 'react-router';
import { fmtDayHeading, todayKey } from '@aperture/shared';
import { Text } from './Text';
import { useSettings } from '../data/hooks/useSettings';
import { useHomeMode } from '../modules/home/home-context';
import { homeModeMeta } from '../modules/home/homeMode';
import { ModeSwitch } from '../modules/home/ModeSwitch';

// The home header: identity + the day + the mode you're in, with the auto/override switch. Quiet by
// design — the field-notebook top matter, not a chrome-heavy app bar.
//
// The date and the mode switch share a row on desktop and stack on a phone: at 390px the tagline
// wrapped mid-phrase because a four-segment switch was taking half the width.
export function AppHeader() {
  const { data: settings } = useSettings();
  const { mode } = useHomeMode();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const meta = homeModeMeta[mode];

  return (
    <header className="py-5">
      <div className="flex items-center justify-between gap-4">
        <Link to="/" className="w-fit">
          <Text weight="semibold" size="lg" className="tracking-tight">
            Aperture
          </Text>
        </Link>
        <ModeSwitch />
      </div>
      <Text as="p" size="sm" tone="muted" className="mt-0.5">
        {fmtDayHeading(today)} <span className="text-ink-subtle">·</span> {meta.tagline}
      </Text>
    </header>
  );
}
