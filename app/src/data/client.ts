import type { ApiClient } from '@aperture/shared';
import { createStubClient } from './stubClient';

// The single ApiClient for the running app. Page-first: the in-memory stub today; Phase 10 swaps
// this one line for the HTTP client (same interface) behind a feature flag. Nothing else changes.
export const api: ApiClient = createStubClient();
