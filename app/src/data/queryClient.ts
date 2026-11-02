import { QueryClient } from '@tanstack/react-query';
import { retryQuery, retryQueryDelay } from './retry';

export const queryClient = new QueryClient({
  defaultOptions: {
    // Reads retry a 5xx or a dropped connection; mutations never do (they may have landed). A 429 is
    // retried for every call one layer down, in the http client.
    queries: {
      // Not 'online' (the default): that pauses a read while the browser reports offline, so it never
      // fails — an offline launch would sit on "Loading…" for good. Offline, a read fails and says so.
      networkMode: 'always',
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: retryQuery,
      retryDelay: retryQueryDelay,
    },
  },
});
