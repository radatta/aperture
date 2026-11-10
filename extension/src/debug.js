// Debug mode (Options → Debug mode): a recorder for finding LeetCode's controls — what was clicked, which
// dialogs appeared, how LeetCode's timer state moved — kept in storage.local.debugLog for Options → Export.
// Off, it records nothing. It never records code, request bodies or tokens: wire entries are sizes only, and
// storage keys that look like credentials are redacted.
(function (root) {
  'use strict';
  const api =
    globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
  const MAX = 2000;
  const SECRET = /token|auth|csrf|secret|passw|cookie|jwt|bearer/i;
  const WATCH = ['QD_TIMER_STATE', 'QD_TIMER_HEARTBEAT', 'global_lang'];
  const CLOCK = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  let known = false;
  let enabled = false;
  let early = [];
  let fresh = [];
  let recording = false;

  const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
  function log(type, data) {
    const e = { t: Date.now(), type, ...(data || {}) };
    if (!known) {
      if (early.length < 200) early.push(e);
    } else if (enabled) fresh.push(e);
  }
  setInterval(async () => {
    if (!fresh.length) return;
    const batch = fresh;
    fresh = [];
    try {
      const { debugLog } = await api.storage.local.get('debugLog');
      const all = (Array.isArray(debugLog) ? debugLog : []).concat(batch);
      await api.storage.local.set({ debugLog: all.slice(-MAX) });
    } catch {}
  }, 2000);

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 8; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(`${p}#${n.id}`);
        break;
      }
      const cls = [...n.classList].slice(0, 3).join('.');
      if (cls) p += `.${cls}`;
      const sibs = n.parentElement
        ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName)
        : [];
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  }
  function describe(el) {
    const attrs = {};
    for (const a of el.attributes || [])
      if (/^(data-|aria-|id$|class$|title$|role$|type$)/.test(a.name))
        attrs[a.name] = clip(a.value, 120);
    // An icon button's own text is empty and its <svg> falls past the outerHTML cut: name the icon.
    const svg = el.querySelector && el.querySelector('svg');
    return {
      tag: el.tagName.toLowerCase(),
      text: clip((el.textContent || '').trim(), 60),
      attrs,
      icon: svg
        ? {
            dataIcon: clip(svg.getAttribute('data-icon'), 60),
            class: clip(svg.getAttribute('class'), 120),
          }
        : null,
      html: clip(el.outerHTML, 400),
      path: cssPath(el),
    };
  }
  // On a failed Start step: every control near where LeetCode's reset and timer live, so the export names them.
  function dumpControls() {
    const pick = (q) => [...document.querySelectorAll(q)].slice(0, 30).map(describe);
    log('controls', {
      editor: pick('#editor button'),
      labelled: pick('button[aria-label]'),
      // LeetCode's timer controls are div[role=button], not buttons.
      roleButtons: pick('[role="button"][aria-label]'),
      dialogs: pick('[role="dialog"] button, [role="alertdialog"] button'),
    });
  }

  function startRecording() {
    if (recording) return;
    recording = true;
    document.addEventListener(
      'click',
      (e) => {
        const el =
          e.target &&
          e.target.closest &&
          e.target.closest('button,[role=button],[role=tab],[role=menuitem],a');
        if (el && !el.closest('aperture-lc-overlay')) log('click', describe(el));
      },
      true,
    );
    new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const d = n.matches('[role=dialog],[role=alertdialog]')
            ? n
            : n.querySelector('[role=dialog],[role=alertdialog]');
          if (d)
            log('dom.dialog', {
              dialog: describe(d),
              buttons: [...d.querySelectorAll('button')].slice(0, 10).map(describe),
            });
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
    const last = {};
    setInterval(() => {
      try {
        const keys = WATCH.concat(
          Object.keys(localStorage).filter((k) => k.startsWith('qd_solve_session:')),
        );
        for (const k of keys) {
          const v = SECRET.test(k) ? '[redacted]' : clip(localStorage.getItem(k), 300);
          if (last[k] !== v) {
            last[k] = v;
            log('storage', { key: k, value: v });
          }
        }
      } catch {}
    }, 1000);
    setInterval(() => {
      const clocks = [...document.querySelectorAll('div,span,button,p')]
        .filter((e) => e.childElementCount === 0 && CLOCK.test((e.textContent || '').trim()))
        .slice(0, 5)
        .map((e) => ({ text: e.textContent.trim(), path: cssPath(e) }));
      if (clocks.length)
        log('sample', { clocks, timer: clip(localStorage.getItem('QD_TIMER_STATE'), 300) });
    }, 2000);
    const nextData = () => {
      try {
        const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
        const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
        log('nextData', {
          queryKeys: queries.slice(0, 40).map((q) => clip(JSON.stringify(q.queryKey), 120)),
          hasQuestion: queries.some((q) => q?.state?.data?.question?.titleSlug),
        });
      } catch {
        log('nextData', { found: false });
      }
    };
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', nextData, { once: true });
    else nextData();
  }

  function set(on) {
    known = true;
    enabled = !!on;
    if (enabled) {
      fresh.push(...early);
      startRecording();
    }
    early = [];
  }
  api.storage.local.get('debug').then(
    ({ debug }) => set(debug),
    () => set(false),
  );
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.debug) set(changes.debug.newValue);
  });

  (root.ApertureLC = root.ApertureLC || {}).debug = { log, dumpControls, describe };
})(globalThis);
