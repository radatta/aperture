// The real Options page (options.html and the scripts it lists, in its order) in jsdom, over the fake extension
// API: the version it shows, the coach's one switch, Debug mode and its export, the connection and selectors.
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { fakeExtension, manifest, src, tick, until } from './load';

type Ext = ReturnType<typeof fakeExtension>;
function optionsPage(ext: Ext) {
  const html = src('options.html');
  const dom = new JSDOM(html, {
    url: 'safari-web-extension://ext-id/options.html',
    runScripts: 'outside-only',
  });
  const w = dom.window as unknown as Window &
    typeof globalThis & { eval(code: string): unknown; chrome: unknown };
  w.chrome = ext.api;
  const copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', {
    value: { writeText: async (t: string) => void copied.push(t) },
  });
  // The scripts as the page lists them, so a script the page stops loading fails here too.
  const scripts = [...w.document.querySelectorAll('script[src]')].map((s) =>
    s.getAttribute('src')!,
  );
  expect(scripts.at(-1)).toBe('src/options.js');
  for (const f of scripts) w.eval(src(f));
  const $ = <T extends HTMLElement = HTMLInputElement>(id: string) =>
    w.document.getElementById(id) as T;
  const toggle = (id: string, on: boolean) => {
    $(id).checked = on;
    $(id).dispatchEvent(new w.Event('change'));
  };
  const click = (id: string) => $(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const status = (id: string) => $(id).textContent ?? '';
  const save = (origin: string, token: string) => {
    $('apiOrigin').value = origin;
    $('deviceToken').value = token;
    $('options-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  };
  return { w, $, toggle, click, status, save, copied };
}
// load()'s reads are the fake storage's microtasks: one macrotask turn sees them all done.
const loaded = async (ext: Ext) => {
  const o = optionsPage(ext);
  await tick(0);
  return o;
};

describe('the Options page', () => {
  it('shows the version Safari runs, from the manifest; unknown when the browser won’t say', async () => {
    const o = await loaded(fakeExtension());
    expect(o.status('version')).toBe(`Version ${manifest.version}`);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    const none = await loaded(
      fakeExtension({
        version: () => {
          throw new Error('no manifest');
        },
      }),
    );
    expect(none.status('version')).toBe('Version unknown');
  });

  it('has one coach switch, the resubmit note: on by default, saved off, still off after a reload', async () => {
    const ext = fakeExtension();
    const o = await loaded(ext);
    expect(o.$('coachTrace')).toBeNull();
    expect(o.$('coachHold')).toBeNull();
    expect(o.w.document.body.textContent).not.toMatch(/trace card|Trace or Skip/i);
    expect(o.$('coachNudge').checked).toBe(true);
    o.toggle('coachNudge', false);
    await until(() => o.status('coachStatus') === 'Saved.');
    expect(ext.local.data.coachNudge).toBe(false);
    const again = await loaded(ext);
    expect(again.$('coachNudge').checked).toBe(false);
    again.toggle('coachNudge', true);
    await until(() => ext.local.data.coachNudge === true);
  });

  it('removes the retired trace card’s switches from storage on load', async () => {
    const ext = fakeExtension();
    await ext.local.set({ coachTrace: false, coachHold: false, coachNudge: false });
    const o = await loaded(ext);
    await until(() => !('coachTrace' in ext.local.data) && !('coachHold' in ext.local.data));
    expect(ext.local.data.coachNudge).toBe(false); // the note's own stays
    expect(o.$('coachNudge').checked).toBe(false);
  });

  it('Debug mode toggles `debug`, and survives a reload', async () => {
    const ext = fakeExtension();
    const o = await loaded(ext);
    expect(o.$('debug').checked).toBe(false);
    o.toggle('debug', true);
    await until(() => ext.local.data.debug === true);
    expect((await loaded(ext)).$('debug').checked).toBe(true);
    o.toggle('debug', false);
    await until(() => ext.local.data.debug === false);
  });

  it('Copy JSON leads the log with the version that wrote it; an empty log still says it', async () => {
    const ext = fakeExtension();
    await ext.local.set({ debugLog: [{ t: 1, type: 'nav', slug: 'two-sum' }] });
    const o = await loaded(ext);
    o.click('copyLog');
    await until(() => o.copied.length === 1);
    const log = JSON.parse(o.copied[0]!) as Array<Record<string, unknown>>;
    expect(log[0]).toEqual({ t: expect.any(Number), type: 'export', version: manifest.version });
    expect(log.slice(1)).toEqual([{ t: 1, type: 'nav', slug: 'two-sum' }]);
    o.click('clearLog');
    await until(() => !('debugLog' in ext.local.data));
    o.click('copyLog');
    await until(() => o.copied.length === 2);
    expect(JSON.parse(o.copied[1]!)).toEqual([
      { t: expect.any(Number), type: 'export', version: manifest.version },
    ]);
  });

  it('saves the connection only when it is usable, then tells the background', async () => {
    const ext = fakeExtension({ onMessage: () => ({ ok: true }) }); // the background answers
    const o = await loaded(ext);
    o.save('not a url', 't');
    await until(() => o.status('saveStatus').includes('not a valid URL'));
    o.save('http://aperture.example.com', 't');
    await until(() => o.status('saveStatus').includes('must be https'));
    o.save('https://aperture.example.com', '  ');
    await until(() => o.status('saveStatus').includes('Enter a device token'));
    expect(ext.local.data.apiOrigin).toBeUndefined();
    o.save('https://aperture.example.com///', ' tok ');
    await until(() => o.status('saveStatus').startsWith('Saved.'));
    expect(ext.local.data).toMatchObject({
      apiOrigin: 'https://aperture.example.com',
      deviceToken: 'tok',
    });
    expect(ext.sent).toContainEqual({ type: 'config-changed' });
    o.save('http://localhost:8787', 'tok'); // http only for localhost
    await until(() => ext.local.data.apiOrigin === 'http://localhost:8787');
  });

  it('saves selector overrides as JSON over the defaults; bad JSON and unknown keys save nothing', async () => {
    const ext = fakeExtension();
    const o = await loaded(ext);
    const saveSel = (text: string) => {
      o.$<HTMLTextAreaElement>('selectors').value = text;
      o.click('saveSelectors');
    };
    saveSel('{bad');
    await until(() => o.status('selectorStatus').includes('isn’t valid JSON'));
    saveSel('{"trace": "#x"}');
    await until(() => o.status('selectorStatus').includes('Unknown keys: trace'));
    saveSel('[1]');
    await until(() => o.status('selectorStatus').includes('must be a JSON object'));
    expect(ext.local.data.selectors).toBeUndefined();
    saveSel('{"submit": null, "editorReset": "#reset"}');
    await until(() => o.status('selectorStatus').startsWith('Saved.'));
    expect(ext.local.data.selectors).toEqual({ submit: null, editorReset: '#reset' });
    expect((await loaded(ext)).$<HTMLTextAreaElement>('selectors').value.replace(/\s/g, '')).toBe(
      '{"submit":null,"editorReset":"#reset"}',
    );
    o.click('resetSelectors');
    await until(() => !('selectors' in ext.local.data));
  });
});
