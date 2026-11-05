import type { DocClient, Item } from './DocClient';
import type { Writes } from './writes';
import { PLACE_TOKEN_SK, pk, placeTokenPk, sk } from './keys';
import { toEntity } from './mapping';

// The Shortcut token's storage (places.md → Token). Two rows, neither holding the token itself:
//   u#<uid> / ptoken                       — the pointer: which hash is this user's live token (the
//                                            authority — a read is refused unless it names its hash),
//                                            and which old ones are still to delete (Repo writes it)
//   placetoken#<sha256hex> / placetoken    — the lookup row (here): who the token belongs to, plus its
//                                            daily read counter — finds the user and the cap
// The lookup row lives outside every user partition, so it isn't on Repo. Writes go through `writes`.

// Rotate/revoke write it with putIf on the updatedAt they read, so two devices can't both win; the
// loser undoes its own lookup row. `retiring` = hashes whose lookup rows are still to delete — a delete
// cut short leaves them here, and the next rotate/revoke deletes them. Cleanup only: a retiring row that
// outlives its delete still can't read, because the pointer no longer names it (resolvePlaceRead).
export interface PlaceTokenPointer {
  hash: string | null; // null: no live token (revoked)
  createdAt: number | null;
  hint: string | null; // the token's last 4, for Settings
  retiring: string[];
  updatedAt: number;
}

export interface PlaceTokenRow {
  userId: string; // the only source of the partition a read is scoped to
  createdAt: number;
  updatedAt: number; // the conditional-write cursor: a count never writes a revoked row back to life
  lastUsedAt: number | null;
  readsDay: string | null; // the UTC day readsCount counts (dayKey(now, 0))
  readsCount: number;
  hint: string;
}

// A pointer whose cursor isn't a number can't be written back conditionally (rotate/revoke would compare
// against NaN/undefined) — refuse it by name rather than guess.
export class PlaceTokenPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceTokenPointerError';
  }
}
export function pointerOf(item: Item): PlaceTokenPointer {
  const r = toEntity<PlaceTokenPointer>(item);
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt))
    throw new PlaceTokenPointerError('Corrupt place-token pointer: no updatedAt');
  return {
    hash: r.hash ?? null,
    createdAt: r.createdAt ?? null,
    hint: r.hint ?? null,
    retiring: r.retiring ?? [],
    updatedAt: r.updatedAt,
  };
}

const toRow = (item: Item): PlaceTokenRow => {
  const r = toEntity<PlaceTokenRow>(item);
  return {
    userId: r.userId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt ?? null,
    readsDay: r.readsDay ?? null,
    readsCount: r.readsCount ?? 0,
    hint: r.hint,
  };
};
const itemOf = (hash: string, row: PlaceTokenRow): Item => ({
  PK: placeTokenPk(hash),
  SK: PLACE_TOKEN_SK,
  ...row,
});

export class PlaceTokenStore {
  constructor(
    private readonly doc: DocClient,
    private readonly writes: Writes,
  ) {}

  async get(hash: string, opts?: { consistent?: boolean }): Promise<PlaceTokenRow | null> {
    const it = await this.doc.get(placeTokenPk(hash), PLACE_TOKEN_SK, opts);
    return it ? toRow(it) : null;
  }
  // The lookup row's user's pointer — the Shortcut read's authority check, before any userId-scoped Repo
  // exists. Consistent: a rotate/revoke a moment ago must already refuse the old hash.
  async pointer(userId: string): Promise<PlaceTokenPointer | null> {
    const it = await this.doc.get(pk(userId), sk.ptoken(), { consistent: true });
    return it ? pointerOf(it) : null;
  }
  // A freshly minted token: written only if absent.
  async create(hash: string, row: PlaceTokenRow): Promise<void> {
    await this.writes.putIf(itemOf(hash, row), null);
  }
  // `next` lands only while the stored row is still `prev` — ConditionFailedError otherwise (a read that
  // raced it, or a revoke/rotate that deleted the row).
  async replace(hash: string, prev: PlaceTokenRow, next: PlaceTokenRow): Promise<void> {
    await this.writes.putIf(itemOf(hash, next), prev.updatedAt);
  }
  async delete(hash: string): Promise<void> {
    await this.writes.delete(placeTokenPk(hash), PLACE_TOKEN_SK);
  }
}
