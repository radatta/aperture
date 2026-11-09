// A Chrome-loadable copy of the shipped extension, for the E2E only. The shipped manifest's background is
// `background.scripts` — the event-page shape Safari runs (extension/README.md) — which Chrome's MV3 refuses;
// this copy swaps in a service worker that imports the same two files, and lets the background reach the
// local server. The overlay's shadow roots are closed, so this build alone also gets the `scripting`
// permission and one extra isolated-world script, listed first, that keeps each root it sees made — the test
// reads them through chrome.scripting in that same world. Every shipped file is copied byte for byte, so
// the E2E runs the shipped code.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs in the isolated world before the overlay: attachShadow there records host → root.
const ROOTS = `(() => {
  const roots = new WeakMap();
  const real = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const r = real.call(this, init);
    roots.set(this, r);
    return r;
  };
  globalThis.__apertureTestRoots = (host) => (host && roots.get(host)) || null;
})();
`;

export function chromeBuild(extensionDir: string): string {
  const out = mkdtempSync(join(tmpdir(), 'aperture-lc-ext-'));
  for (const f of ['manifest.json', 'options.html', 'src', 'icons'])
    cpSync(join(extensionDir, f), join(out, f), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
    background: { scripts?: string[]; service_worker?: string };
    host_permissions: string[];
    permissions: string[];
    content_scripts: Array<{ world?: string; js: string[] }>;
  };
  const scripts = manifest.background.scripts ?? [];
  manifest.background = { service_worker: 'sw.js' };
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*'];
  manifest.permissions = [...manifest.permissions, 'scripting'];
  manifest.content_scripts.find((c) => c.world !== 'MAIN')!.js.unshift('test-roots.js');
  writeFileSync(join(out, 'test-roots.js'), ROOTS);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(out, 'sw.js'),
    `importScripts(${scripts.map((s) => JSON.stringify(s)).join(', ')});\n`,
  );
  return out;
}
