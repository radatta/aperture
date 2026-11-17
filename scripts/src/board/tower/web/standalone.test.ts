import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Home Screen app's header clears the status bar (docs/ops/TOWER.md → Phone): the app's own metas, and a floor
// on the top padding, installed and upright on the phone only, so a 0 inset from iOS can't put it under the bar
// again. A text test: jsdom evaluates neither display-mode nor env(); the capture's standalone frames run the CSS.
const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const app = readFileSync(join(import.meta.dirname, '../../../../../app/index.html'), 'utf8');
const META = [
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
];
const FLOOR = 'padding-top: calc(max(env(safe-area-inset-top, 0px), 62px) + 8px);';
const STRIP = 'top: max(env(safe-area-inset-top, 0px), 62px);'; // an expanded panel's sticky strip (TOWER.md → Expand)
const QUERY =
  /^@media \(display-mode: standalone\) and \(orientation: portrait\),\s*\(display-mode: fullscreen\) and \(orientation: portrait\) \{/;

// The block opened by the `{` at or after `from`, by brace depth: [start, end) of its text.
function block(from: number): [number, number] {
  const open = html.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return [from, i + 1];
  }
  throw new Error('unclosed block');
}

describe('the tower as a Home Screen app', () => {
  it("carries the Aperture app's two status-bar metas, word for word", () => {
    for (const m of META) {
      expect(app).toContain(m);
      expect(html).toContain(m);
    }
    expect(html).toContain('viewport-fit=cover');
  });

  it('floors the header only inside the phone rule, installed and upright, after its shorthand', () => {
    expect(html.split(FLOOR)).toHaveLength(2); // exactly one floor
    // and no other but the strip's, whatever gap follows it
    expect(html.match(/62px\)/g)).toHaveLength(2);
    expect(html.split(STRIP)).toHaveLength(2);
    const at = html.indexOf(FLOOR);
    const phones = [...html.matchAll(/@media \(max-width: 700px\) \{/g)].map((m) => block(m.index));
    const phone = phones.find(([a, b]) => a < at && at < b);
    expect(phone).toBeDefined();
    const text = html.slice(...phone!);
    const short = text.indexOf('padding: calc(env(safe-area-inset-top, 0px) + 8px)');
    expect(short).toBeGreaterThan(-1);
    const query = text.lastIndexOf('@media', at - phone![0]);
    expect(query).toBeGreaterThan(short); // after the shorthand, so it wins the cascade
    expect(text.slice(query)).toMatch(QUERY);
    const [qa, qb] = block(phone![0] + query);
    expect(qa < at && at < qb).toBe(true); // inside that query's own block
    const strip = html.indexOf(STRIP); // the strip's floor, in the same block
    expect(qa < strip && strip < qb).toBe(true);
    // nothing later sets the header's top padding again
    expect(html.slice(at + FLOOR.length)).not.toMatch(/header \{[^}]*padding(-top)?:/);
    // the tab layout keeps its own inset plus gap
    expect(html).toContain('padding: calc(env(safe-area-inset-top, 0px) + 12px)');
  });
});
