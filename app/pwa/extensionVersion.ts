import { readFileSync } from 'node:fs';

// The LeetCode extension's version as this checkout has it (extension/manifest.json — its one home). Both
// Vite configs put it in VITE_LC_EXTENSION_VERSION, so Settings → LeetCode can say when the build Safari ran
// at the last Start is behind the one this app was built with (extension/README.md → Versions).
export function lcExtensionVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error('extension/manifest.json has no version');
  return manifest.version;
}
