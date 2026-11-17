import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Home Screen app's header clears the status bar (docs/ops/TOWER.md → Phone): the app's own metas, and a floor
// on the top padding that applies only when installed, so a 0 inset from iOS can't put it under the bar again.
const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const app = readFileSync(join(import.meta.dirname, '../../../../../app/index.html'), 'utf8');
const META = [
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
];
const FLOOR =
  /@media \(display-mode: standalone\), \(display-mode: fullscreen\) \{\s*header \{\s*padding-top: calc\(max\(env\(safe-area-inset-top, 0px\), 62px\) \+ (\d+)px\);/g;

describe('the tower as a Home Screen app', () => {
  it("carries the Aperture app's two status-bar metas, word for word", () => {
    for (const m of META) {
      expect(app).toContain(m);
      expect(html).toContain(m);
    }
    expect(html).toContain('viewport-fit=cover');
  });

  it('floors the header under the status bar at the desktop and phone rules, installed only', () => {
    const gaps = [...html.matchAll(FLOOR)].map((m) => Number(m[1]));
    expect(gaps).toEqual([12, 8]); // each rule's own gap above the floor
    // the browser-tab rules are unchanged: the inset plus the gap
    expect(html).toContain('padding: calc(env(safe-area-inset-top, 0px) + 12px)');
    expect(html).toContain('padding: calc(env(safe-area-inset-top, 0px) + 8px)');
    // the phone floor sits inside the phone rule, after its padding shorthand, so the shorthand can't undo it
    const phone = html.indexOf('@media (max-width: 700px) {\n        header {');
    expect(phone).toBeGreaterThan(-1);
    expect(html.lastIndexOf('62px) + 8px')).toBeGreaterThan(phone);
  });
});
