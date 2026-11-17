// The local devcheck server's collaborators (docs/ops/LOCAL-CHECK.md): the real edges over one InMemoryDoc,
// the real Cognito verifier fed the run's JWKS (it never fetches one), and inert gateways. Importing the edges
// still builds their live clients at module scope, but no request reaches them: every handler path goes
// through these deps, and serve.ts runs with no table, pool or bucket configured.
import { createCognitoVerifier } from '../auth/verify';
import type { Jwks } from '../auth/verify';
import { InMemoryDoc } from '../ddb/DocClient';
import { noopGoogle } from '../google/gateway';
import { fakePresigner } from '../s3/presigner';
import { noopObjectStore } from '../s3/objects';
import { noopPlaid } from '../plaid/gateway';
import { noopInvoker } from '../finance/invoker';
import { noopAnthropic } from '../anthropic/gateway';
import type { AnthropicGateway } from '../anthropic/gateway';
import { inlinePickInvoker } from '../coach/invoker';
import { runCoachPick } from '../coach/pick';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { standInCoachPick } from '@aperture/shared';
import { createECDH } from 'node:crypto';
import type { PublicKeyReader } from '../push/publicKey';
import type { BffDeps } from '../index';
import type { McpDeps } from '../mcp/index';

export interface LocalAuth {
  poolId: string; // the issuer the harness signed its tokens for: us-west-1_<alnum>
  claudeClientId: string; // denied on the BFF, the only client /mcp accepts (D14) — as deployed
  jwks: Jwks; // public half only; the harness keeps the private key
}

export function localDeps(auth: LocalAuth): { bff: BffDeps; mcp: McpDeps; doc: InMemoryDoc } {
  const doc = new InMemoryDoc();
  // The coach's AI pick runs the real worker inline, answered by the shared stand-in through the real guardrails:
  // every step but the model (the real call is dev's slow row).
  const standIn: AnthropicGateway = {
    ...noopAnthropic(),
    coachPick: async (req) => ({
      ok: true,
      fields: standInCoachPick(req.ctx),
      model: 'local-stand-in',
      usage: null,
      ms: 0,
    }),
  };
  const coachPickInvoker = inlinePickInvoker((e) =>
    runCoachPick(
      { repo: new Repo(doc, liveWrites(doc), e.userId), anthropic: standIn, now: Date.now },
      e,
    ),
  );
  const shared = {
    doc,
    google: noopGoogle(),
    presigner: fakePresigner(),
    objects: noopObjectStore(),
    anthropic: noopAnthropic(), // raw save, as a stage with no key; real-model rows run on dev
    coachPickInvoker,
  };
  // The deployed construction exactly: the BFF's un-bound verifier denying the claude client, and the MCP
  // verifier bound to it (index.ts, mcp/index.ts requireMcpVerifier).
  const bffVerifier = createCognitoVerifier(auth.poolId, null, {
    rejectClientIds: [auth.claudeClientId],
    jwks: auth.jwks,
  });
  const mcpVerifier = createCognitoVerifier(auth.poolId, auth.claudeClientId, { jwks: auth.jwks });
  return {
    doc,
    bff: {
      ...shared,
      verifier: bffVerifier,
      plaid: noopPlaid(),
      financeInvoker: noopInvoker(),
      pushPublicKey: localPushKey(), // so Settings' opt-in runs; nothing sends locally — the poller chain is dev's
    },
    mcp: {
      ...shared,
      mcpVerifier: () => mcpVerifier,
      upload: async () => {
        throw new Error('local: attachment upload runs on dev');
      },
    },
  };
}

// A throwaway VAPID public key per run (an uncompressed P-256 point, base64url — the shape SSM holds). Its
// private half is dropped: no poller runs locally, so nothing is ever signed with it.
function localPushKey(): PublicKeyReader {
  const key = createECDH('prime256v1');
  key.generateKeys();
  const pub = key.getPublicKey().toString('base64url');
  return async () => pub;
}
