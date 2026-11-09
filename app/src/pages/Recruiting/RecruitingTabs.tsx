import { NavLink } from 'react-router';
import { cx } from '../../lib/cx';

// The recruiting hub's tab bar. Styled like the ModeToggle segmented control, but each tab is a real
// NavLink to a route — so the active tab comes from the URL (aria-current for free), it's linkable, and
// back/forward moves between tabs. `end` on Sittings so it isn't marked active on /recruiting/stories.
const TABS = [
  { to: '/recruiting', label: 'Sittings', end: true },
  { to: '/recruiting/stories', label: 'Stories', end: false },
];

export function RecruitingTabs() {
  return (
    <nav
      aria-label="Recruiting sections"
      className="inline-flex shrink-0 gap-0.5 self-start rounded-xl border border-line bg-surface p-0.5"
    >
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx(
              'rounded-[0.625rem] px-3 py-1.5 text-sm transition',
              isActive
                ? 'bg-teal-soft font-medium text-ink shadow-[inset_0_0_0_1px_var(--teal-soft)]'
                : 'text-ink-muted hover:bg-panel hover:text-ink',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
