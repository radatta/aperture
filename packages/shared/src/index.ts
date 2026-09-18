// @aperture/shared — the cross-cutting contract. Barrel export.
export * from './types';
export * from './ulid';
export * from './dates';
export * from './machines';
export * from './recurrence';
export * from './calendar';
export * from './leetcode';
export * from './stories';
export * from './attachments';
export * from './api';
export * from './rpc';
// NB: ./contractTests is intentionally NOT re-exported here — it imports vitest and is consumed only
// by test files via the '@aperture/shared/contract' subpath, so it never lands in an app/Lambda bundle.

export const APERTURE = 'aperture' as const;
