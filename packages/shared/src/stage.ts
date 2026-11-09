// The dev account's stage slots (INFRA §2): `dev` (slot A) and `devb` (slot B) share the account, its SCPs, kill
// switch and alarms. Every dev-only safety (the table's on-demand ceiling and TTL, the TTL stamp) keys off isDevSlot,
// never `stage === 'dev'`, so slot B can't be created without them (the freeze keeps a ceiling only if one exists).
export const DEV_SLOTS = ['dev', 'devb'] as const;
export type DevSlot = (typeof DEV_SLOTS)[number];

export const isDevSlot = (stage: string | undefined): stage is DevSlot =>
  (DEV_SLOTS as readonly string[]).includes(stage ?? '');
