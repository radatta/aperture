// What a dev-logs fetch may ask for — shared by the bot CLI (checks before dispatching) and
// scripts/aws/fetch-dev-logs.mjs (checks again on the runner, where the inputs are untrusted). Node builtins
// only and erasable syntax: the runner imports this under plain `node` (type stripping).

// The whole allowlist. Each maps to a dev slot's group — slot A bare, slot B with `-devb` — so no input can name a
// prod group (docs/ops/CI-BOT.md). The dev-logs role reads exactly these (cdk/src/lib/cicd-stack.ts → LOG_FNS).
export const LOG_GROUPS = {
  bff: '/aws/lambda/aperture-bff-dev',
  mcp: '/aws/lambda/aperture-mcp-dev',
  'finance-sync': '/aws/lambda/aperture-finance-sync-dev',
  'push-dispatch': '/aws/lambda/aperture-push-dispatch-dev',
  'bff-devb': '/aws/lambda/aperture-bff-devb',
  'mcp-devb': '/aws/lambda/aperture-mcp-devb',
  'finance-sync-devb': '/aws/lambda/aperture-finance-sync-devb',
  'push-dispatch-devb': '/aws/lambda/aperture-push-dispatch-devb',
} as const;
export type LogGroup = keyof typeof LOG_GROUPS;

export const MAX_WINDOW_MS = 6 * 60 * 60 * 1000;
export const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface LogsRequest {
  startMs: number;
  endMs: number;
  groups: LogGroup[];
  groupNames: string[];
  key: string;
}

const isGroup = (g: string): g is LogGroup => Object.hasOwn(LOG_GROUPS, g);

// Throws with a one-line reason on anything outside the allowlist or the window rules.
export function parseLogsRequest(
  input: { start: string; end: string; groups: string; key: string },
  now = Date.now(),
): LogsRequest {
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs))
    throw new Error(`start/end must be ISO timestamps (got "${input.start}", "${input.end}")`);
  if (endMs <= startMs) throw new Error('end must be after start');
  if (endMs - startMs > MAX_WINDOW_MS) throw new Error('window is longer than 6 h — narrow it');
  if (startMs > now) throw new Error('start is in the future');
  if (!KEY_RE.test(input.key)) throw new Error('key must be [A-Za-z0-9._-], at most 100 chars');
  const names = input.groups
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error('no log groups given');
  const bad = names.filter((g) => !isGroup(g));
  if (bad.length)
    throw new Error(
      `unknown log group(s) ${bad.join(', ')} — allowed: ${Object.keys(LOG_GROUPS).join(', ')}`,
    );
  const groups = [...new Set(names)] as LogGroup[];
  return { startMs, endMs, groups, groupNames: groups.map((g) => LOG_GROUPS[g]), key: input.key };
}
