// The dev check’s BFF client (api.ts), places: places, their tasks and the place token.
// Its internals come from core.ts under the names the bodies use.
import { AUTH_HEADER, assertDevOrigin, targetOrigin } from '../config';
import { DevcheckError } from '../errors';
import { pendingIds } from '../ledger';
import {
  type Core,
  type DevPlace,
  type DevPlaceDigest,
  type DevPlaceTokenStatus,
  PLACE_VIA,
  bffError,
  ledgerKind,
} from './core';

export function placesReads(c: Core) {
  const { fetch, backoff, call } = c;
  const reads = {
    listPlaces: () => call<DevPlace[]>('listPlaces', []),
    // The digest as an RPC read — no heartbeat, no count (the Shortcut route below is the one that counts).
    listPlaceTasks: (slug: string) => call<DevPlaceDigest>('listPlaceTasks', [slug]),
    getPlaceTokenStatus: () => call<DevPlaceTokenStatus>('getPlaceTokenStatus', []),
    // The iPhone Shortcut's route, raw: GET /api/places/<slug>/tasks with the place token (never the session
    // JWT) in the BFF header, or none — the status and parsed body, whatever they are, so a step can assert a
    // refusal. A 200 bumps the token's count and the place's lastReadAt server-side, as the Shortcut does;
    // every other answer writes nothing (lambdas/src/index.ts) and carries `{error, text}` — never a 404,
    // which CloudFront would rewrite to the app shell. `method` is GET but for proving the 405. A 429
    // carrying the BFF's own `{error}` is the daily cap, returned as is; any other 429 is Lambda throttling
    // and is backed off like call()'s.
    async placeDigestRaw(
      slug: string,
      placeToken: string | null,
      method: 'GET' | 'POST' = 'GET',
    ): Promise<{ status: number; body: unknown }> {
      const url = `${targetOrigin()}/api/places/${encodeURIComponent(slug)}/tasks`;
      assertDevOrigin(url);
      const headers: Record<string, string> = placeToken
        ? { [AUTH_HEADER]: `Bearer ${placeToken}` }
        : {};
      const { status, text } = await backoff(
        () => fetch(url, { method, headers, redirect: 'error' }),
        (s, t) => s === 429 && !bffError(t),
      );
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        return { status, body: text.slice(0, 200) };
      }
    },
  };
  return reads;
}

export function placesWrites(c: Core) {
  const { ledger, run, call, assertLedger, recordTokenMint } = c;
  const writes = {
    // Create (no id) is ledgered like createTask — intent, then the server's id; an update must name a place
    // the ledger recorded.
    async upsertPlace(input: { id?: string; name: string; slug?: string }): Promise<DevPlace> {
      if (input.id) {
        assertLedger(input.id, 'place');
        return call<DevPlace>('upsertPlace', [input]);
      }
      ledger.append({ run, op: 'intent', via: PLACE_VIA, title: input.name });
      const place = await call<DevPlace>('upsertPlace', [input]);
      ledger.append({ run, op: 'created', id: place.id, via: PLACE_VIA, title: input.name });
      return place;
    },
    // Its alive tasks move to `reassignToSlug`, or off any list (null) — cleanup passes null.
    async deletePlace(id: string, reassignToSlug: string | null): Promise<void> {
      assertLedger(id, 'place');
      await call<null>('deletePlace', [id, reassignToSlug]);
    },
    // The plaintext comes back once; it lives in the step's memory only — never logged, never ledgered.
    async rotatePlaceToken(): Promise<{ token: string; status: DevPlaceTokenStatus }> {
      recordTokenMint();
      return call<{ token: string; status: DevPlaceTokenStatus }>('rotatePlaceToken', []);
    },
    // The ledger half alone, for Settings' Generate / Rotate: called before the click, so a token the
    // browser mints is recorded like one rotated here. Writes nothing to dev.
    recordPlaceTokenMint: (): void => recordTokenMint(),
    // Only while the ledger holds a token a run minted and nothing has resolved yet: the test user's token
    // is the harness's to revoke only when the harness made it.
    async revokePlaceToken(): Promise<void> {
      const entries = ledger.read();
      if (!pendingIds(entries).some((id) => ledgerKind(entries, id) === 'placeToken'))
        throw new DevcheckError(
          'LEDGER_GUARD',
          'refusing to revoke the place token — no run recorded minting it',
        );
      await call<null>('revokePlaceToken', []);
    },
  };
  return writes;
}
