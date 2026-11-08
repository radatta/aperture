// The local devcheck server's collaborators (docs/ops/LOCAL-CHECK.md): the real edges over one InMemoryDoc,
// the real Cognito verifier fed the run's JWKS, and inert gateways — nothing here can construct a live
// AWS, Google, Plaid or Claude client, so a local run makes no call off the machine.
import { createCognitoVerifier } from '../auth/verify';
import type { Jwks } from '../auth/verify';
import { InMemoryDoc } from '../ddb/DocClient';
import { noopGoogle } from '../google/gateway';
import { fakePresigner } from '../s3/presigner';
import { noopObjectStore } from '../s3/objects';
import { noopPlaid } from '../plaid/gateway';
import { noopInvoker } from '../finance/invoker';
import { noopAnthropic } from '../anthropic/gateway';
import type { BffDeps } from '../index';
import type { McpDeps } from '../mcp/index';

export interface LocalAuth {
  poolId: string; // the issuer the harness signed its tokens for: us-west-1_<alnum>
  claudeClientId: string; // denied on the BFF, the only client /mcp accepts (D14) — as deployed
  jwks: Jwks; // public half only; the harness keeps the private key
}

export function localDeps(auth: LocalAuth): { bff: BffDeps; mcp: McpDeps; doc: InMemoryDoc } {
  const doc = new InMemoryDoc();
  const shared = {
    doc,
    google: noopGoogle(),
    presigner: fakePresigner(),
    objects: noopObjectStore(),
    anthropic: noopAnthropic(), // raw save, as a stage with no key; real-model rows run on dev
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
    bff: { ...shared, verifier: bffVerifier, plaid: noopPlaid(), financeInvoker: noopInvoker() },
    mcp: {
      ...shared,
      mcpVerifier: () => mcpVerifier,
      upload: async () => {
        throw new Error('local: attachment upload runs on dev');
      },
    },
  };
}
