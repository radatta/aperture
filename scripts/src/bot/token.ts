// Installation tokens: 1 hour, this repo only, and only the permissions the command needs. Minted per
// invocation and held in memory — no token cache on disk (nothing secret at rest besides the key itself).
import { appJwt } from './jwt.ts';
import { makeApi } from './api.ts';
import type { BotConfig } from './config.ts';
import { OWNER, REPO } from './config.ts';

export type Permissions = Partial<Record<'contents' | 'actions', 'read' | 'write'>>;

// The narrowest set per command (metadata:read is implied). Never workflows, never administration, and no
// pull requests — the user opens PRs (docs/ops/CI-BOT.md → App permissions).
export const PERMS = {
  push: { contents: 'write' },
  lock: { contents: 'write' },
  deployDev: { contents: 'write', actions: 'write' },
  logs: { actions: 'write' },
} as const satisfies Record<string, Permissions>;

export async function mintToken(
  config: BotConfig,
  permissions: Permissions,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<string> {
  const app = makeApi(appJwt(config.clientId, config.privateKey, nowMs), fetchImpl);
  let id = config.installationId;
  if (!id) {
    const installs = await app<{ id: number; account: { login: string } }[]>(
      'GET',
      '/app/installations',
    );
    const mine = installs.find((i) => i.account.login === OWNER);
    if (!mine) throw new Error(`the App is not installed on ${OWNER} — Install App → only ${REPO}`);
    id = String(mine.id);
  }
  const res = await app<{ token: string }>('POST', `/app/installations/${id}/access_tokens`, {
    repositories: [REPO],
    permissions,
  });
  return res.token;
}
