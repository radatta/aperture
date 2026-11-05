// `pnpm -s vapid-keys` — a fresh VAPID key pair for one stage's reminders (docs/areas/tasks/reminders.md →
// Operator steps): line 1 the public key (the 65-octet uncompressed P-256 point), line 2 the private key (the
// raw 32-octet scalar), both base64url — the shapes lambdas/src/push/webpush.ts reads. Prints to stdout only;
// the operator line pipes it straight into SSM, so the private key is never written to a file or shown.
// Plain `node` (type stripping), builtins only.
import { createECDH } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function vapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const raw = ecdh.getPrivateKey();
  const privateKey = Buffer.concat([Buffer.alloc(32 - raw.length), raw]); // always 32 octets
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { publicKey, privateKey } = vapidKeys();
  process.stdout.write(`${publicKey}\n${privateKey}\n`);
}
