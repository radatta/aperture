import { lazy, Suspense, type ComponentType } from 'react';
import { EmptyState } from '../components/EmptyState';

// A route element whose page comes from a lazy chunk: React.lazy inside the element, not the router's
// `lazy` — a route-level fallback blanks the whole shell on a deep link, while a Suspense here keeps the
// shell up with "Loading…" in the outlet until the chunk lands (docs/areas/flux D64). `load` is the dynamic
// import, `pick` the page in it; several pages behind one `load` share one chunk and one request.
export function lazyPage<M>(load: () => Promise<M>, pick: (m: M) => ComponentType) {
  const Page = lazy(() => load().then((m) => ({ default: pick(m) })));
  return (
    <Suspense fallback={<EmptyState pending title="" />}>
      <Page />
    </Suspense>
  );
}
