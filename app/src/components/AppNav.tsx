import { NavLink } from 'react-router';
import { cx } from '../lib/cx';

// Home = glance, deep views = work. This slim row is how you reach the deep views; the active one is
// underlined in gold. `end` on Home so it isn't marked active on every sub-route.
// The row scrolls sideways rather than wrapping — six links at 390px were one word from breaking
// onto a second line and pushing the whole page down.
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
    <nav className="no-scrollbar -mx-5 flex gap-x-5 overflow-x-auto border-b border-line px-5 pb-2.5 text-sm">
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) =>
            cx(
              'shrink-0 border-b-2 pb-1 transition',
              isActive ? 'border-gold text-ink' : 'border-transparent text-ink-muted hover:text-ink',
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
