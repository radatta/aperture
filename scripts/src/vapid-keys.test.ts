import { execFileSync } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { vapidKeys } from './vapid-keys.ts';

describe('vapid-keys', () => {
  it('makes a P-256 pair: a 65-octet uncompressed public point and the 32-octet private scalar it derives from', () => {
    const { publicKey, privateKey } = vapidKeys();
    const pub = Buffer.from(publicKey, 'base64url');
    const priv = Buffer.from(privateKey, 'base64url');
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(0x04);
    expect(priv).toHaveLength(32);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    expect(ecdh.getPublicKey().toString('base64url')).toBe(publicKey);
    expect(publicKey).toMatch(/^[\w-]+$/); // base64url, no padding — what the SSM put and the browser take
    expect(vapidKeys().privateKey).not.toBe(privateKey);
  });

  it('prints the public key on line 1 and the private key on line 2, nothing else', () => {
    const script = fileURLToPath(new URL('./vapid-keys.ts', import.meta.url));
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3); // two lines and the trailing newline
    expect(lines[2]).toBe('');
    expect(Buffer.from(lines[0]!, 'base64url')).toHaveLength(65);
    expect(Buffer.from(lines[1]!, 'base64url')).toHaveLength(32);
  });
});
