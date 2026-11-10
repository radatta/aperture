import { Link, useLocation } from 'react-router';
import { cx } from '../../lib/cx';

// The recruiting hub's tab bar. Styled like the ModeToggle segmented control, but each tab is a real link to a
// route — so the active tab comes from the URL, it's linkable, and back/forward moves between tabs. Sittings
// owns /recruiting and a sitting's own page under it; Stories owns /recruiting/stories.
const TABS = [
  { to: '/recruiting', label: 'Sittings' },
  { to: '/recruiting/stories', label: 'Stories' },
];
const activeTab = (path: string) =>
  path.startsWith('/recruiting/stories') ? '/recruiting/stories' : '/recruiting';

export function RecruitingTabs() {
  const active = activeTab(useLocation().pathname);
  return (
    <nav
      aria-label="Recruiting sections"
      className="inline-flex shrink-0 gap-0.5 self-start rounded-xl border border-line bg-surface p-0.5"
    >
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          aria-current={t.to === active ? 'page' : undefined}
          className={cx(
            'rounded-[0.625rem] px-3 py-1.5 text-sm transition',
            t.to === active
              ? 'bg-teal-soft font-medium text-ink shadow-[inset_0_0_0_1px_var(--teal-soft)]'
              : 'text-ink-muted hover:bg-panel hover:text-ink',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
