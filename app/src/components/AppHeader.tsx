import { Link } from 'react-router';
import { fmtDayHeading, todayKey } from '@aperture/shared';
import { Text } from './Text';
import { useSettings } from '../data/hooks/useSettings';
import { useHomeMode } from '../modules/home/home-context';
import { homeModeMeta } from '../modules/home/homeMode';
import { ModeSwitch } from '../modules/home/ModeSwitch';

// The home header: identity + the day + the mode you're in, with the auto/override switch. Quiet by
// design — the field-notebook top matter, not a chrome-heavy app bar.
export function AppHeader() {
  const { data: settings } = useSettings();
  const { mode } = useHomeMode();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const meta = homeModeMeta[mode];

  return (
    <header className="flex items-center justify-between gap-4 py-5">
      <div className="flex flex-col gap-0.5">
        <Link to="/" className="w-fit">
          <Text weight="semibold" size="lg" className="tracking-tight">
            Aperture
          </Text>
        </Link>
        <Text size="sm" tone="muted">
          {fmtDayHeading(today)} · {meta.tagline}
        </Text>
      </div>
      <ModeSwitch />
    </header>
  );
}
