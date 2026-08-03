import { NavLink } from 'react-router';
import { cx } from '../lib/cx';

// Home = glance, deep views = work. This slim row is how you reach the deep views; the active one is
// underlined in gold. `end` on Home so it isn't marked active on every sub-route.
const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/log', label: 'Log' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/habits', label: 'Habits' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/settings', label: 'Settings' },
];

export function AppNav() {
  return (
    <nav className="flex flex-wrap gap-x-5 gap-y-2 border-b border-line pb-3 text-sm">
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) =>
            cx(
              'border-b-2 pb-0.5 transition',
              isActive
                ? 'border-gold text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
