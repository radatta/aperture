import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';
import { cx } from '../lib/cx';

// Home = glance, deep views = work. This slim row is how you reach the deep views; the active one is
// underlined in gold. `end` on Home so it isn't marked active on every sub-route.
// The row scrolls sideways rather than wrapping — the links already overflow 390px and would
// otherwise break onto a second line and push the whole page down.
const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/log', label: 'Log' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/recruiting', label: 'Recruiting' },
  { to: '/habits', label: 'Habits' },
  { to: '/rolls', label: 'Rolls' },
  { to: '/flux', label: 'Flux' },
  { to: '/finances', label: 'Finances' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/settings', label: 'Settings' },
];

const EDGE_PAD = 20; // px-5

export function AppNav() {
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // Keep the active link visible: at 390px the later tabs sit past the row's right edge. Scrolls the
  // row only — scrollIntoView would also move the page vertically.
  useEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector('[aria-current="page"]');
    if (!nav || !link) return;
    const n = nav.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    if (l.right > n.right) nav.scrollLeft += l.right - n.right + EDGE_PAD;
    else if (l.left < n.left) nav.scrollLeft -= n.left - l.left + EDGE_PAD;
  }, [pathname]);
  return (
    <nav
      ref={navRef}
      className="no-scrollbar -mx-5 flex gap-x-5 overflow-x-auto border-b border-line px-5 pb-2.5 text-sm"
    >
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) =>
            cx(
              'shrink-0 border-b-2 pb-1 transition',
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
