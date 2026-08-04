import { runApiContract } from '@aperture/shared/contract';
import { createStubClient } from './stubClient';

// The stub, run against the shared ApiClient contract. The SAME suite runs against the Lambda backend
// (lambdas/src/backend.contract.test.ts) — if the two ever diverge, one of these two goes red.
runApiContract('stub', (now) =>
  createStubClient({ seed: false, now, storageKey: `contract-${Math.random()}` }),
);
