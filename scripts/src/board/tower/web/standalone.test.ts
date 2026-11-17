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
  it('app.js marks the page installed from navigator.standalone or display-mode', () => {
    const js = readFileSync(join(import.meta.dirname, 'app.js'), 'utf8');
    expect(js).toContain('navigator.standalone === true');
    expect(js).toContain("document.documentElement.classList.add('installed')");
  });

  // F161: the next step on the parked header clipping is to read what the phone reports, not another CSS guess
  it('carries the status-bar readout, off by default: ?debug=1 or five taps on the serving line', () => {
    const js = readFileSync(join(import.meta.dirname, 'app.js'), 'utf8');
    expect(js).toContain("new URLSearchParams(location.search).get('debug') === '1'");
    expect(js).toContain("'empty serving'");
    expect(js).toMatch(/taps\.length >= 5/);
    for (const k of [
      'display-mode:',
      'navigator.standalone:',
      'safe-area-inset top',
      'header padding-top',
    ])
      expect(js).toContain(k);
    expect(html).toMatch(/#dbg \{[^}]*position: fixed;/);
    expect(html).not.toContain('id="dbg"'); // made only when asked for
  });

  it("carries the Aperture app's two status-bar metas, word for word", () => {
    for (const m of META) {
      expect(app).toContain(m);
      expect(html).toContain(m);
    }
    expect(html).toContain('viewport-fit=cover');
  });

  it('floors the header only inside the phone rule, installed and upright, after its shorthand', () => {
    // two floors, each with the strip's: the display-mode query's, and the `installed` class's (app.js sets it when
    // iOS opens the app in a mode the query misses); no other, whatever gap follows it
    expect(html.split(FLOOR)).toHaveLength(3);
    expect(html.split(STRIP)).toHaveLength(3);
    expect(html.match(/62px\)/g)).toHaveLength(4);
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
    // the class's floor: the next rule in the same phone block, upright only
    const at2 = html.indexOf(FLOOR, at + 1);
    expect(phone![0] < at2 && at2 < phone![1]).toBe(true);
    expect(html.slice(qb, at2)).toMatch(
      /^\s*\/\*[^*]*\*\/\s*@media \(orientation: portrait\) \{\s*html\.installed header \{\s*$/,
    );
    // both class rules inside that portrait block, never loose in the phone block (a sideways phone has no bar)
    const [pa, pb] = block(qb + html.slice(qb).indexOf('@media (orientation: portrait)'));
    expect(pa < at2 && at2 < pb).toBe(true);
    const strip2 = html.indexOf(STRIP, html.indexOf(STRIP) + 1);
    expect(pa < strip2 && strip2 < pb).toBe(true);
    expect(html.slice(pa, pb)).toContain('html.installed #strip {');
    // nothing later sets the header's top padding again
    expect(html.slice(at2 + FLOOR.length)).not.toMatch(/header \{[^}]*padding(-top)?:/);
    // the tab layout keeps its own inset plus gap
    expect(html).toContain('padding: calc(env(safe-area-inset-top, 0px) + 12px)');
  });
});
