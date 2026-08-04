import type { ApiClient } from '@aperture/shared';
import { API_BASE, API_MODE } from '../shared/env';
import { createHttpClient } from './httpClient';
import { createStubClient } from './stubClient';

// The single ApiClient for the running app — the page-first seam. Stub by default; flip
// VITE_API_MODE=http (Phase 12 build) to talk to the real Lambda BFF. Same interface either way, so
// nothing else in the app changes. Both are proven against one shared contract suite.
export const api: ApiClient = API_MODE === 'http' ? createHttpClient(API_BASE) : createStubClient();
