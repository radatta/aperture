// Loads the extension's real files for tests: the pure libs through require (their UMD wrapper exports under
// node), and the page/background scripts into a jsdom window or a vm context, exactly as the browser runs them.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const src = (rel: string) => readFileSync(join(root, rel), 'utf8');
export const manifest = JSON.parse(src('manifest.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const lib = (name: string): any => require(join(root, 'src/lib', `${name}.js`));

// The script lists the manifest gives each world, in order.
export const MAIN_JS: string[] = manifest.content_scripts.find(
  (c: { world?: string }) => c.world === 'MAIN',
).js;
export const ISOLATED_JS: string[] = manifest.content_scripts.find(
  (c: { world?: string }) => c.world !== 'MAIN',
).js;
export const BACKGROUND_JS: string[] = manifest.background.scripts;

// A jsdom page at `url`, with node's WebCrypto and TextEncoder (jsdom has no SubtleCrypto).
export function page(url: string, html = '<!doctype html><html><head></head><body></body></html>') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, unknown>;
  Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  return dom;
}
// Runs files in the page's own realm (as content scripts run). `extra` is set on the window first — the
// fake extension API for the isolated world, the fake fetch for the page world.
export function run(dom: JSDOM, files: string[], extra: Record<string, unknown> = {}) {
  const w = dom.window as unknown as Record<string, unknown> & { eval(code: string): unknown };
  Object.assign(w, extra);
  for (const f of files) w.eval(src(f));
}
// A vm context for the background page, with `extra` as its globals.
export function background(extra: Record<string, unknown>) {
  const ctx = vm.createContext({
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    URL,
    ...extra,
  });
  (ctx as Record<string, unknown>).globalThis = ctx;
  for (const f of BACKGROUND_JS) vm.runInContext(src(f), ctx, { filename: f });
  return ctx;
}

// A fake extension API: storage.local/session (with onChanged), runtime messaging, alarms, permissions.
export function fakeExtension(opts: { onMessage?: (msg: unknown) => unknown; id?: string } = {}) {
  const id = opts.id ?? 'ext-id';
  const listeners: Array<(changes: object, area: string) => void> = [];
  const msgListeners: Array<(m: unknown, s: unknown, r: (v: unknown) => void) => boolean | void> =
    [];
  const area = (name: string) => {
    const data: Record<string, unknown> = {};
    // A listener from a closed test page may throw; the others still hear the change.
    const notify = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) =>
      listeners.forEach((l) => {
        try {
          l(changes, name);
        } catch {
          // a closed page
        }
      });
    const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    return {
      data,
      async get(keys?: string | string[] | null) {
        const ks = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of ks) if (k in data) out[k] = clone(data[k]);
        return out;
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: clone(v) };
          data[k] = clone(v);
        }
        notify(changes);
      },
      async remove(keys: string | string[]) {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (!(k in data)) continue;
          changes[k] = { oldValue: data[k] };
          delete data[k];
        }
        notify(changes);
      },
    };
  };
  const local = area('local');
  const session = area('session');
  const alarms: Array<{ name: string; when: number }> = [];
  const alarmListeners: Array<(a: { name: string }) => void> = [];
  const sent: unknown[] = [];
  const api = {
    runtime: {
      id,
      onMessage: { addListener: (l: (typeof msgListeners)[number]) => msgListeners.push(l) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      async sendMessage(msg: unknown) {
        sent.push(msg);
        if (opts.onMessage) return opts.onMessage(msg);
        // delivered to this fake's own listeners — a background loaded with the same fake
        return new Promise((resolve) => {
          for (const l of msgListeners) l(msg, { id }, resolve);
        });
      },
    },
    storage: {
      local,
      session,
      onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) },
    },
    alarms: {
      create: (name: string, o: { when: number }) => alarms.push({ name, when: o.when }),
      onAlarm: { addListener: (l: (a: { name: string }) => void) => alarmListeners.push(l) },
      fire: (name: string) => alarmListeners.forEach((l) => l({ name })),
    },
    permissions: { request: async () => true },
  };
  return { api, local, session, alarms, sent, msgListeners };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timed out');
    await tick(10);
  }
}
