import { ModeToggle } from '../../components/ModeToggle';
import { MoonIcon, SunIcon, SunriseIcon } from '../../components/icons';
import type { HomeMode } from '../../styles/theme';
import { useHomeMode } from './home-context';

type Choice = 'auto' | HomeMode;

// "Auto" is the default and the one you leave it on, so it's the only labelled segment on desktop.
// On a phone it collapses to a clock glyph — a four-segment control with a word in it was taking
// half the header width at 390px.
const OPTIONS = [
  {
    value: 'auto' as const,
    label: (
      <>
        <span className="hidden sm:inline">Auto</span>
        <span className="sm:hidden">◐</span>
      </>
    ),
    title: 'Follow the clock',
  },
  { value: 'morning' as const, label: <SunriseIcon />, title: 'Morning' },
  { value: 'day' as const, label: <SunIcon />, title: 'Daytime' },
  { value: 'night' as const, label: <MoonIcon />, title: 'Night' },
];

// The manual override. "Auto" follows the clock; picking a mode pins it (and tints the theme to
// match) until you switch back to Auto or reload.
export function ModeSwitch() {
  const { mode, isAuto, setOverride } = useHomeMode();
  const value: Choice = isAuto ? 'auto' : mode;
  return (
    <ModeToggle<Choice>
      size="sm"
      options={OPTIONS}
      value={value}
      onChange={(v) => setOverride(v === 'auto' ? null : v)}
    />
  );
}
