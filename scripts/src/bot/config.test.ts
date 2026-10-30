import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseEnvFile, secretsDir } from './config.ts';

function makeSecrets(
  dirMode = 0o700,
  fileMode = 0o600,
  env = 'APP_ID=5307707\nCLIENT_ID=Iv23x\n',
): string {
  const dir = mkdtempSync(join(tmpdir(), 'bot-secrets-'));
  writeFileSync(join(dir, 'app.env'), env);
  writeFileSync(join(dir, 'private-key.pem'), 'PEM');
  chmodSync(join(dir, 'app.env'), fileMode);
  chmodSync(join(dir, 'private-key.pem'), fileMode);
  chmodSync(dir, dirMode);
  return dir;
}

describe('bot config', () => {
  it('loads app.env + the key from a 700 dir of 600 files', () => {
    expect(loadConfig(makeSecrets())).toEqual({
      appId: '5307707',
      clientId: 'Iv23x',
      installationId: undefined,
      privateKey: 'PEM',
    });
  });

  it('refuses a key readable by others, naming the fix', () => {
    expect(() => loadConfig(makeSecrets(0o700, 0o644))).toThrow(
      /mode 644, must be 600 — chmod 600/,
    );
  });

  it('refuses a dir others can list', () => {
    expect(() => loadConfig(makeSecrets(0o755))).toThrow(/mode 755, must be 700/);
  });

  it('refuses a missing dir with the setup pointer', () => {
    expect(() => loadConfig(join(tmpdir(), 'no-such-bot-dir'))).toThrow(
      /missing — set up the bot key/,
    );
  });

  it('needs both ids', () => {
    expect(() => loadConfig(makeSecrets(0o700, 0o600, 'APP_ID=1\n'))).toThrow(
      /APP_ID and CLIENT_ID/,
    );
  });

  it('parses KEY=VALUE lines and ignores the rest', () => {
    expect(parseEnvFile('# c\nAPP_ID=1\n\n CLIENT_ID = Iv23 \nINSTALLATION_ID=9')).toEqual({
      APP_ID: '1',
      CLIENT_ID: 'Iv23',
      INSTALLATION_ID: '9',
    });
  });

  it('honours the APERTURE_BOT_SECRETS override', () => {
    expect(secretsDir({ APERTURE_BOT_SECRETS: '/x/y' })).toBe('/x/y');
  });
});
