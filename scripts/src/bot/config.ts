// The bot's identity on disk: `<main checkout>/.secrets/ci-bot/{app.env,private-key.pem}` on the Mac-shared mount
// (gitignored, dir 700, files 600 — docs/ops/CI-BOT.md). Read in-process only; nothing here is ever printed.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_SLUG as SLUG } from '../identifiers.ts';
import { run } from './sh.ts';

export const REPO_SLUG = SLUG; // identifiers.json → repo
export const [OWNER, REPO] = REPO_SLUG.split('/') as [string, string];
export const REPO_URL = `https://github.com/${REPO_SLUG}.git`;
export const PROTECTED = new Set(['main', 'master', 'dev']);

export interface BotConfig {
  appId: string;
  clientId: string;
  installationId?: string;
  privateKey: string;
}

// The main checkout's .secrets, from any worktree: the common git dir is `<main checkout>/.git`.
// APERTURE_BOT_SECRETS overrides (tests).
export function secretsDir(env = process.env): string {
  if (env.APERTURE_BOT_SECRETS) return env.APERTURE_BOT_SECRETS;
  return join(
    dirname(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    '.secrets',
    'ci-bot',
  );
}

function requireMode(path: string, want: number): void {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new Error(`${path} is missing — set up the bot key first (docs/ops/CI-BOT.md → Setup)`);
  }
  if (mode !== want)
    throw new Error(
      `${path} is mode ${mode.toString(8)}, must be ${want.toString(8)} — chmod ${want.toString(8)} it`,
    );
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

export function loadConfig(dir = secretsDir()): BotConfig {
  requireMode(dir, 0o700);
  const envPath = join(dir, 'app.env');
  const keyPath = join(dir, 'private-key.pem');
  requireMode(envPath, 0o600);
  requireMode(keyPath, 0o600);
  const env = parseEnvFile(readFileSync(envPath, 'utf8'));
  if (!env.APP_ID || !env.CLIENT_ID) throw new Error(`${envPath} needs APP_ID and CLIENT_ID`);
  return {
    appId: env.APP_ID,
    clientId: env.CLIENT_ID,
    installationId: env.INSTALLATION_ID,
    privateKey: readFileSync(keyPath, 'utf8'),
  };
}
