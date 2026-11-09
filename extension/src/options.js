// The options page: the connection (origin + device token), the outbox's last send, debug mode and its
// export, and selector overrides (lib/selectors.js merges them over the defaults).
(() => {
  'use strict';
  const api =
    globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
  const local = api.storage.local;
  const $ = (id) => document.getElementById(id);
  const say = (id, msg, kind) => {
    $(id).textContent = msg;
    $(id).className = `status ${kind || ''}`;
  };
  const tell = (type) => api.runtime.sendMessage({ type }).catch(() => {});

  // ---- connection ----
  async function load() {
    const got = await local.get([
      'apiOrigin',
      'deviceToken',
      'debug',
      'selectors',
      'status',
      'outbox',
    ]);
    if (typeof got.apiOrigin === 'string') $('apiOrigin').value = got.apiOrigin;
    if (typeof got.deviceToken === 'string') $('deviceToken').value = got.deviceToken;
    $('debug').checked = !!got.debug;
    $('selectors').value = got.selectors ? JSON.stringify(got.selectors, null, 2) : '';
    showStatus(got.status, got.outbox);
  }

  // Not async: permissions.request must run inside the click's user gesture, before anything is awaited
  // (Firefox and Safari reject it otherwise). It resolves true at once when the origin is already granted.
  $('options-form').addEventListener('submit', (e) => {
    e.preventDefault();
    say('saveStatus', '');
    const apiOrigin = $('apiOrigin').value.trim().replace(/\/+$/, '');
    const deviceToken = $('deviceToken').value.trim();
    let parsed;
    try {
      parsed = new URL(apiOrigin);
    } catch {
      return say('saveStatus', 'The API origin is not a valid URL.', 'err');
    }
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal))
      return say('saveStatus', 'The API origin must be https (http only for localhost).', 'err');
    if (!deviceToken) return say('saveStatus', 'Enter a device token.', 'err');
    let asked;
    try {
      asked = api.permissions.request({ origins: [`${parsed.origin}/*`] });
    } catch (err) {
      return say('saveStatus', `Permission request failed: ${(err && err.message) || err}`, 'err');
    }
    Promise.resolve(asked)
      .then(async (granted) => {
        await local.set({ apiOrigin: parsed.origin, deviceToken });
        await tell('config-changed');
        if (granted) say('saveStatus', `Saved. Allowed to reach ${parsed.origin}.`, 'ok');
        else say('saveStatus', `Saved, but nothing sends until you allow ${parsed.origin}.`, 'err');
      })
      .catch((err) => say('saveStatus', `Couldn’t save: ${(err && err.message) || err}`, 'err'));
  });

  // ---- last send ----
  function showStatus(status, queue) {
    const s = status || {};
    const entries = (queue && queue.entries) || [];
    const failed = entries.filter((e) => e.state === 'failed');
    const lines = [];
    if (s.at)
      lines.push(
        `${new Date(s.at).toLocaleString()} — ${s.state || 'ok'}${s.http ? ` (HTTP ${s.http})` : ''}`,
      );
    if (s.detail) lines.push(s.detail);
    if (queue && queue.paused === 'auth')
      lines.push('Paused: Aperture refused the device token. Save a new one to resume.');
    if (queue && queue.paused === 'config') lines.push('Paused: no origin or token yet.');
    lines.push(`${entries.length - failed.length} queued · ${failed.length} failed`);
    for (const f of failed.slice(0, 5))
      lines.push(`Failed (HTTP ${f.lastStatus}): ${f.lastError || 'refused'}`);
    $('lastSend').replaceChildren(
      ...lines.map((l) => Object.assign(document.createElement('div'), { textContent: l })),
    );
  }
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.status || changes.outbox))
      local.get(['status', 'outbox']).then((g) => showStatus(g.status, g.outbox));
  });
  $('retryNow').addEventListener('click', () => tell('retry-now'));
  $('clearFailed').addEventListener('click', () => {
    if (confirm('Drop the captures Aperture refused? They will not be sent.')) tell('clear-failed');
  });

  // ---- debug ----
  $('debug').addEventListener('change', () => local.set({ debug: $('debug').checked }));
  const logJson = async () => JSON.stringify((await local.get('debugLog')).debugLog || [], null, 1);
  $('exportLog').addEventListener('click', async () => {
    const url = URL.createObjectURL(new Blob([await logJson()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `aperture-lc-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    say('debugStatus', 'Exported. If Safari opened it in a tab instead, use Copy JSON.', 'ok');
  });
  $('copyLog').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(await logJson());
      say('debugStatus', 'Copied.', 'ok');
    } catch (err) {
      say('debugStatus', `Couldn’t copy: ${(err && err.message) || err}`, 'err');
    }
  });
  $('clearLog').addEventListener('click', async () => {
    await local.remove('debugLog');
    say('debugStatus', 'Cleared.', 'ok');
  });

  // ---- selectors ----
  $('saveSelectors').addEventListener('click', async () => {
    const text = $('selectors').value.trim();
    if (!text) {
      await local.remove('selectors');
      return say('selectorStatus', 'Using the defaults.', 'ok');
    }
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return say('selectorStatus', 'That isn’t valid JSON — nothing saved.', 'err');
    }
    if (!o || typeof o !== 'object' || Array.isArray(o))
      return say('selectorStatus', 'Selectors must be a JSON object.', 'err');
    const unknown = Object.keys(o).filter((k) => !globalThis.ApertureLC.selectors.KEYS.includes(k));
    if (unknown.length)
      return say('selectorStatus', `Unknown keys: ${unknown.join(', ')} — nothing saved.`, 'err');
    await local.set({ selectors: o });
    say('selectorStatus', 'Saved. Open LeetCode tabs pick it up at once.', 'ok');
  });
  $('resetSelectors').addEventListener('click', async () => {
    await local.remove('selectors');
    $('selectors').value = '';
    say('selectorStatus', 'Using the defaults.', 'ok');
  });

  load().catch(() => say('saveStatus', 'Couldn’t load saved settings.', 'err'));
})();
