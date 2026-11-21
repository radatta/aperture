// The options page: the version, the connection (origin + device token), the outbox's last send, the coach's
// note switch (lib/coach.js), debug mode and its export, and selector overrides (lib/selectors.js merges them
// over the defaults).
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
  const { coach, selectors: selLib } = globalThis.ApertureLC;
  // An override with a retired key (lib/selectors.js RETIRED) → {kept, dropped, off}: the rest, the retired keys it
  // had, and whether `submit: null` (the note off, before 2.2.1) was among them.
  function stripRetired(o) {
    const kept = { ...o };
    const dropped = selLib.RETIRED.filter((k) => Object.prototype.hasOwnProperty.call(o, k));
    for (const k of dropped) delete kept[k];
    return { kept, dropped, off: dropped.includes('submit') && o.submit === null };
  }
  // Saves an override without its retired keys (removed when nothing's left), a `submit: null` carried over to the
  // note's switch. → what's left (null for none) and whether the note went off.
  async function saveStripped(o) {
    const { kept, dropped, off } = stripRetired(o);
    const left = Object.keys(kept).length ? kept : null;
    if (off) await local.set({ [coach.KEYS.nudge]: false });
    if (left) await local.set({ selectors: left });
    else await local.remove('selectors');
    return { left, dropped, off };
  }
  // The build Safari runs (manifest.json); the app's Settings compares it with the one it was built from.
  let version = null;
  try {
    const v = api.runtime.getManifest().version;
    if (typeof v === 'string') version = v;
  } catch {}
  $('version').textContent = version ? `Version ${version}` : 'Version unknown';

  // ---- connection ----
  async function load() {
    const got = await local.get([
      'apiOrigin',
      'deviceToken',
      'debug',
      'selectors',
      'status',
      'outbox',
      ...Object.values(coach.KEYS),
    ]);
    local.remove(coach.RETIRED_KEYS).catch(() => {}); // the retired trace card's switches
    const o = got.selectors;
    if (o && typeof o === 'object' && !Array.isArray(o) && stripRetired(o).dropped.length) {
      const r = await saveStripped(o).catch(() => null);
      if (r) got.selectors = r.left;
      if (r && r.off) got[coach.KEYS.nudge] = false;
    }
    showCoach(coach.settingsOf(got));
    if (typeof got.apiOrigin === 'string') $('apiOrigin').value = got.apiOrigin;
    if (typeof got.deviceToken === 'string') $('deviceToken').value = got.deviceToken;
    $('debug').checked = !!got.debug;
    $('selectors').value = got.selectors ? JSON.stringify(got.selectors, null, 2) : '';
    showStatus(got.status, got.outbox);
  }

  // Not async: permissions.request must run inside the click's user gesture, before anything is awaited
  // (Safari rejects it otherwise). It resolves true at once when the origin is already granted.
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

  // ---- the coach: the resubmit note, on unless stored false ----
  function showCoach(on) {
    $('coachNudge').checked = on.nudge;
  }
  $('coachNudge').addEventListener('change', async () => {
    try {
      await local.set({ [coach.KEYS.nudge]: $('coachNudge').checked });
      showCoach(coach.settingsOf(await local.get(Object.values(coach.KEYS))));
      say('coachStatus', 'Saved.', 'ok');
    } catch (err) {
      say('coachStatus', `Couldn’t save: ${(err && err.message) || err}`, 'err');
    }
  });

  // ---- debug ----
  $('debug').addEventListener('change', () => local.set({ debug: $('debug').checked }));
  // The log, led by an entry naming the build that wrote it (the array shape the readers know), with any tail a page
  // wrote as it left (debug.js) folded in.
  const tailKeys = (all) => Object.keys(all).filter((k) => k.startsWith('debugTail.'));
  const logJson = async () => {
    const all = await local.get(null);
    const entries = (Array.isArray(all.debugLog) ? all.debugLog : [])
      .concat(...tailKeys(all).map((k) => (Array.isArray(all[k]) ? all[k] : [])))
      .sort((a, b) => a.t - b.t);
    return JSON.stringify([{ t: Date.now(), type: 'export', version }, ...entries], null, 1);
  };
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
    await local.remove(['debugLog', ...tailKeys(await local.get(null))]);
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
    const unknown = Object.keys(stripRetired(o).kept).filter((k) => !selLib.KEYS.includes(k));
    if (unknown.length)
      return say('selectorStatus', `Unknown keys: ${unknown.join(', ')} — nothing saved.`, 'err');
    const { left, dropped, off } = await saveStripped(o);
    if (off) showCoach(coach.settingsOf(await local.get(Object.values(coach.KEYS))));
    if (dropped.length) $('selectors').value = left ? JSON.stringify(left, null, 2) : '';
    const note = dropped.length
      ? ` ${dropped.join(', ')} is retired (the note reads the submit itself) — dropped${off ? '; the note is now off' : ''}.`
      : '';
    say('selectorStatus', `Saved. Open LeetCode tabs pick it up at once.${note}`, 'ok');
  });
  $('resetSelectors').addEventListener('click', async () => {
    await local.remove('selectors');
    $('selectors').value = '';
    say('selectorStatus', 'Using the defaults.', 'ok');
  });

  load().catch(() => say('saveStatus', 'Couldn’t load saved settings.', 'err'));
})();
