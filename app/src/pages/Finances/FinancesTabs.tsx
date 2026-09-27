import { NavLink } from 'react-router';
import { cx } from '../../lib/cx';

// Same segmented tab bar as RecruitingTabs — each tab a real route, `end` on the index.
const TABS = [
  { to: '/finances', label: 'Sort', end: true },
  { to: '/finances/all', label: 'All', end: false },
  { to: '/finances/rules', label: 'Rules', end: false },
];

export function FinancesTabs() {
  return (
    <nav
      aria-label="Finances sections"
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
