import { lazy, Suspense, type ComponentType } from 'react';
import { EmptyState } from '../components/EmptyState';

// A route element whose page comes from a lazy chunk: React.lazy inside the element, not the router's
// `lazy` — a route-level fallback blanks the whole shell on a deep link, while a Suspense here keeps the
// shell up with "Loading…" in the outlet until the chunk lands (docs/areas/flux D64). `load` is the dynamic
// import, `pick` the page in it; several pages behind one `load` share one chunk and one request.
// A chunk that fails to load (offline before the service worker cached it) lands in the outlet too, with
// Retry — not on the router's default error page, which would replace the shell. The browser's module map
// records the failed fetch for this document, so Retry is a reload, not a second import().
export function lazyPage<M>(load: () => Promise<M>, pick: (m: M) => ComponentType) {
  const Page = lazy(() =>
    load().then(
      (m): { default: ComponentType } => ({ default: pick(m) }),
      (): { default: ComponentType } => ({
        default: () => <EmptyState error onRetry={() => window.location.reload()} title="" />,
      }),
    ),
  );
  return (
    <Suspense fallback={<EmptyState pending title="" />}>
      <Page />
    </Suspense>
  );
}
