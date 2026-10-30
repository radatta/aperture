import { NavLink } from 'react-router';
import { cx } from '../../lib/cx';

// Flux's two tabs, Library and History (D50) — RecruitingTabs' segmented control, each tab a real NavLink
// so the active tab comes from the URL. The stage (/flux/:id) keeps its back link instead.
const TABS = [
  { to: '/flux', label: 'Library', end: true },
  { to: '/flux/history', label: 'History', end: false },
];

export function FluxTabs() {
  return (
    <nav
      aria-label="Flux sections"
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
