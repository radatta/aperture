// @aperture/shared — the cross-cutting contract. Barrel export.
export * from './types';
export * from './areas';
export * from './ulid';
export * from './dates';
export * from './machines';
export * from './pulse';
export * from './recurrence';
export * from './calendar';
export * from './leetcode';
export * from './sittings';
export * from './neetcode150';
export * from './catalogs';
export * from './lcCatalog';
export * from './coach';
export * from './coachAi';
export * from './coachProgress';
export * from './traceComment';
export * from './stories';
export * from './rolls';
export * from './split';
export * from './parts';
export * from './attachments';
export * from './taskNotes';
export * from './due';
export * from './places';
export * from './capture';
export * from './reminders';
export * from './calendarSync';
export * from './calendarPull';
export * from './api';
export * from './bulkTasks';
export * from './categorySuggest';
export * from './quickParse';
export * from './spokenTime';
export * from './rpc';
export * from './finance';
export * from './financeFixtures';
export * from './plaidTypes';
export * from './stage';
// NB: ./contractTests is intentionally NOT re-exported here — it imports vitest and is consumed only
// by test files via the '@aperture/shared/contract' subpath, so it never lands in an app/Lambda bundle.

export const APERTURE = 'aperture' as const;
