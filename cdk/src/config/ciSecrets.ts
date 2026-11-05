import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The three per-stage credentials that are plain Lambda env vars, NOT Secrets Manager (INFRA §10) — single-user,
// tiny blast radius: the CloudFront→Lambda origin secret, the LeetCode extension's device token, and the MCP
// agent token (distinct from the device token so the two revoke independently).
export type SecretKind = 'ORIGIN_SECRET' | 'DEVICE_TOKEN' | 'AGENT_TOKEN';

const FILE: Record<SecretKind, string> = {
  ORIGIN_SECRET: 'origin-secret',
  DEVICE_TOKEN: 'device-token',
  AGENT_TOKEN: 'agent-token',
};

export interface StageSecretOptions {
  env?: NodeJS.ProcessEnv; // tests pass their own; the cdk app uses process.env
  dir?: string; // the gitignored secrets dir; defaults to cdk/.secrets/
}

// In CI the value comes from the GitHub secret `<KIND>_<STAGE>` (prod's live in the `prod` environment, dev's are
// repo-level), exported as APERTURE_<KIND> by deploy-stage.yml, so it is stable across runs. Locally it is generated
// once into a gitignored file and reused, so CloudFront + the Lambda (or the registered client) always agree;
// `cat cdk/.secrets/<file>.<stage>` to paste it into the extension options / Claude Code. Never committed.
// In CI an EMPTY value throws instead of falling through to the file: the runner has no file, so CDK would mint a
// fresh value and silently rotate the token — MCP clients and the extension stop matching, and nothing errors.
// A misnamed or missing secret now fails the synth, naming what to set.
export function stageSecret(kind: SecretKind, stage: string, opts: StageSecretOptions = {}): string {
  const env = opts.env ?? process.env;
  const name = `APERTURE_${kind}`;
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  if (env.GITHUB_ACTIONS) {
    const where = stage === 'prod' ? 'a secret in the prod GitHub environment' : 'a repository secret';
    throw new Error(`${name} is empty in CI — set ${kind}_${stage.toUpperCase()} (${where})`);
  }
  const dir = opts.dir ?? fileURLToPath(new URL('../../.secrets', import.meta.url));
  const file = `${dir}/${FILE[kind]}.${stage}`;
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(24).toString('hex');
  writeFileSync(file, `${secret}\n`);
  return secret;
}
