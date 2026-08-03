// @aperture/lambdas — the multi-route BFF handler.
// Phase 10 fills this in: DynamoDB single-table access, one route per ApiClient method,
// the writes object (single audit point), and in-handler Cognito JWT validation.
import { APERTURE } from '@aperture/shared';

export const runtime = `${APERTURE}-lambda` as const;
