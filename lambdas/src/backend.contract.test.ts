import { API_METHODS, dayKeyInZone, USER_TIME_ZONE } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { runApiContract } from '@aperture/shared/contract';
import type { ContractSeed } from '@aperture/shared/contract';
import { InMemoryDoc } from './ddb/DocClient';
import { entityItem } from './ddb/mapping';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { PlaceTokenStore } from './ddb/placeTokens';
import { ScopedTokenStore } from './ddb/scopedTokens';
import { PushRegistry } from './ddb/pushRegistry';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { inlineInvoker } from './finance/invoker';
import { runFinanceSync } from './finance/sync';
import { InMemoryPlaid } from './plaid/gateway';
import { fakePresigner } from './s3/presigner';
import { fakeObjectStore } from './s3/objects';
import { standInCoachPick } from '@aperture/shared';
import { noopAnthropic } from './anthropic/gateway';
import type { AnthropicGateway } from './anthropic/gateway';
import { inlinePickInvoker } from './coach/invoker';
import { runCoachPick } from './coach/pick';

// The Lambda backend, run against the SAME contract suite as the stub — this is the parity proof the
// whole page-first architecture rests on. Two passes:
//   1. BackendClient directly (the business logic over the in-memory table)
//   2. through handleRpc — the real RPC dispatch (method validation + arg passing), end-to-end server-side
// Finances: Plaid is the in-memory fake replaying the shared fixtures, anchored to the user's day like
// the suite's finToday, and a sync runs inline (the RPC returns after it), so the stub's inline sync
// compares 1:1.
// Reminders: the stage has a VAPID public key (the RFC 8291 vector's sender key — any P-256 point works).
const VAPID_PUBLIC_KEY =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const pushPublicKey = async () => VAPID_PUBLIC_KEY;

function financeDeps(doc: DocClient, now: () => number) {
  const plaid = new InMemoryPlaid({ today: () => dayKeyInZone(now(), USER_TIME_ZONE, 4) });
  const financeInvoker = inlineInvoker((e) =>
    runFinanceSync(
      {
        repo: new Repo(doc, liveWrites(doc), e.userId),
        plaid,
        now,
        sleep: async () => {},
        userId: e.userId,
      },
      e,
    ),
  );
  return { plaid, financeInvoker };
}

// The coach's AI pick: the worker runs inline (the RPC returns after it, like the stub), answered by the stub's own
// stand-in through the real guardrails, so the two compare 1:1.
function coachDeps(doc: DocClient, now: () => number) {
  const anthropic: AnthropicGateway = {
    ...noopAnthropic(),
    coachPick: async (req) => ({
      ok: true,
      fields: standInCoachPick(req.ctx),
      model: 'stub',
      usage: null,
      ms: 0,
    }),
  };
  const coachPickInvoker = inlinePickInvoker((e) =>
    runCoachPick(
      { repo: new Repo(doc, liveWrites(doc), e.userId), anthropic, now, log: () => {} },
      e,
    ),
  );
  return { anthropic, coachPickInvoker };
}

// The legacy capture's rows, put where the old writer left them (`lc#<day>#<id>`): nothing writes them any more.
async function seedLegacy(doc: DocClient, seed?: ContractSeed) {
  for (const r of seed?.legacy ?? []) await doc.put(entityItem('local', `lc#${r.day}#${r.id}`, r));
}

runApiContract('lambda (direct)', async (now, seed) => {
  const doc = new InMemoryDoc();
  await seedLegacy(doc, seed);
  return new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
    userId: 'local',
    now,
    presigner: fakePresigner(),
    objects: fakeObjectStore(),
    placeTokens: new PlaceTokenStore(doc, liveWrites(doc)),
    scopedTokens: new ScopedTokenStore(doc, liveWrites(doc)),
    pushRegistry: new PushRegistry(doc, liveWrites(doc)),
    pushPublicKey,
    ...financeDeps(doc, now),
    ...coachDeps(doc, now),
  });
});

runApiContract('lambda (via handleRpc dispatch)', async (now, seed) => {
  const doc = new InMemoryDoc();
  await seedLegacy(doc, seed);
  const deps = {
    presigner: fakePresigner(),
    objects: fakeObjectStore(),
    pushPublicKey,
    ...financeDeps(doc, now),
    ...coachDeps(doc, now),
  };
  const client: Record<string, unknown> = {};
  for (const method of API_METHODS) {
    client[method] = (...args: unknown[]) =>
      handleRpc(doc, { userId: 'local', method, args, now }, deps);
  }
  return client as unknown as ApiClient;
});
