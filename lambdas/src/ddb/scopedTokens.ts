import type { TokenScope } from '@aperture/shared';
import type { DocClient, Item } from './DocClient';
import type { Writes } from './writes';
import { pk, SCOPED_TOKEN_SK, scopedTokenPk, sk } from './keys';
import { toEntity } from './mapping';

// Scoped device tokens' storage (capture.md → Token). Two rows per token, neither holding the token itself:
//   stoken#<sha256hex> / stoken   — the lookup (here, outside every user partition): found by the hash
//                                   alone, it names the user, the token's id and its scope. Never rewritten.
//   u#<uid> / stoken#<id>         — the token (the authority): name, hint, hash, and the daily counters
//                                   and duplicate guard its route keeps. Rewritten conditionally.
// A request is let through only when both exist and agree (resolveScopedToken), so deleting either one kills
// the token. Writes go through `writes`; the store never writes with the doc client.

export interface ScopedTokenLookup {
  userId: string;
  tokenId: string;
  scope: TokenScope;
}

export interface ScopedTokenRow {
  id: string;
  scope: TokenScope;
  name: string;
  hash: string; // its lookup row's key — so revoke can delete it
  hint: string; // the token's last 4, for Settings
  createdAt: number;
  updatedAt: number; // the conditional-write cursor: a count never writes a revoked row back to life
  lastUsedAt: number | null;
  usesDay: string | null; // the UTC day the counters count (dayKey(now, 0))
  uses: number; // requests let through that day
  parses: number; // model calls that day (capture)
  lastTextHash: string | null; // capture's duplicate guard: the last line's sha256…
  lastAt: number | null; // …when it came…
  lastTaskId: string | null; // …and the task it made (null while that capture is still in flight)
}

const toLookup = (item: Item): ScopedTokenLookup => {
  const r = toEntity<ScopedTokenLookup>(item);
  return { userId: r.userId, tokenId: r.tokenId, scope: r.scope };
};
const toRow = (item: Item): ScopedTokenRow => {
  const r = toEntity<ScopedTokenRow>(item);
  return {
    id: r.id,
    scope: r.scope,
    name: r.name,
    hash: r.hash,
    hint: r.hint,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt ?? null,
    usesDay: r.usesDay ?? null,
    uses: r.uses ?? 0,
    parses: r.parses ?? 0,
    lastTextHash: r.lastTextHash ?? null,
    lastAt: r.lastAt ?? null,
    lastTaskId: r.lastTaskId ?? null,
  };
};

export class ScopedTokenStore {
  constructor(
    private readonly doc: DocClient,
    private readonly writes: Writes,
  ) {}

  // Consistent: a token minted a moment ago works at once, and one revoked a moment ago is refused.
  async lookup(hash: string): Promise<ScopedTokenLookup | null> {
    const it = await this.doc.get(scopedTokenPk(hash), SCOPED_TOKEN_SK, { consistent: true });
    return it ? toLookup(it) : null;
  }
  async row(userId: string, id: string): Promise<ScopedTokenRow | null> {
    const it = await this.doc.get(pk(userId), sk.stoken(id), { consistent: true });
    return it ? toRow(it) : null;
  }
  // Every live token of the user's, oldest first (ULID ids sort by mint time).
  async list(userId: string): Promise<ScopedTokenRow[]> {
    const items = await this.doc.query(pk(userId), sk.stokenPrefix(), { consistent: true });
    return items.map(toRow);
  }
  // Both written only if absent.
  async createRow(userId: string, row: ScopedTokenRow): Promise<void> {
    await this.writes.putIf({ PK: pk(userId), SK: sk.stoken(row.id), ...row }, null);
  }
  async createLookup(hash: string, lookup: ScopedTokenLookup): Promise<void> {
    await this.writes.putIf({ PK: scopedTokenPk(hash), SK: SCOPED_TOKEN_SK, ...lookup }, null);
  }
  // `next` lands only while the stored row is still `prev` — ConditionFailedError otherwise (another
  // request counted first, or a revoke deleted it).
  async replaceRow(userId: string, prev: ScopedTokenRow, next: ScopedTokenRow): Promise<void> {
    await this.writes.putIf({ PK: pk(userId), SK: sk.stoken(next.id), ...next }, prev.updatedAt);
  }
  async deleteLookup(hash: string): Promise<void> {
    await this.writes.delete(scopedTokenPk(hash), SCOPED_TOKEN_SK);
  }
  async deleteRow(userId: string, id: string): Promise<void> {
    await this.writes.delete(pk(userId), sk.stoken(id));
  }
}
