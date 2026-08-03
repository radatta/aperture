import { createContext, useContext } from 'react';
import type { ApiClient } from '@aperture/shared';

// The ApiClient is provided via context so it can be swapped (stub → HTTP in Phase 10) and so tests
// can inject an isolated client. Components never import a client directly — they call useApi().
export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used within an ApiContext provider');
  return api;
}
