import type { DocClient, Item } from './DocClient';
import type { Writes } from './writes';
import { PLACE_TOKEN_SK, placeTokenPk } from './keys';
import { toEntity } from './mapping';

// The Shortcut token's storage (places.md → Token). Two rows, neither holding the token itself:
//   u#<uid> / ptoken                       — the pointer: which hash is this user's live token (Repo)
//   placetoken#<sha256hex> / placetoken    — the lookup row (here): who the token belongs to, plus its
//                                            daily read counter — one GetItem is auth + cap check
// The lookup row lives outside every user partition, so it isn't on Repo. Writes go through `writes`.

export interface PlaceTokenPointer {
  hash: string;
  createdAt: number;
  hint: string; // the token's last 4, for Settings
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
