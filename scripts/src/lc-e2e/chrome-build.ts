// A Chrome-loadable copy of the shipped extension, for the E2E only. The shipped manifest's background is
// `background.scripts` — the event-page shape Safari runs (extension/README.md) — which Chrome's MV3 refuses;
// this copy swaps in a service worker that imports the same two files, and lets the background reach the
// local server. Every other file is copied byte for byte, so the E2E runs the shipped code.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function chromeBuild(extensionDir: string): string {
  const out = mkdtempSync(join(tmpdir(), 'aperture-lc-ext-'));
  for (const f of ['manifest.json', 'options.html', 'src', 'icons'])
    cpSync(join(extensionDir, f), join(out, f), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
    background: { scripts?: string[]; service_worker?: string };
    host_permissions: string[];
  };
  const scripts = manifest.background.scripts ?? [];
  manifest.background = { service_worker: 'sw.js' };
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(out, 'sw.js'),
    `importScripts(${scripts.map((s) => JSON.stringify(s)).join(', ')});\n`,
  );
  return out;
}
