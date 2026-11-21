// Debug mode (Options → Debug mode): a recorder for finding LeetCode's controls — what was clicked, which
// dialogs appeared, how LeetCode's timer state moved — kept in storage.local.debugLog for Options → Export.
// Off, it records nothing. It never records code, request bodies or tokens: wire entries are sizes only,
// storage keys that look like credentials are redacted, and nothing inside the code editor is described.
// The timer probes (F392/F393, the probe session in extension/README.md → Debug mode) record what LeetCode's
// timer pop-up, its tabs and duration fields answer to, the tab's visibility, late ticks and storage events.
(function (root) {
  'use strict';
  const api =
    globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
  const MAX = 2000;
  const SECRET = /token|auth|csrf|secret|passw|cookie|jwt|bearer/i;
  const WATCH = ['QD_TIMER_STATE', 'QD_TIMER_HEARTBEAT', 'global_lang'];
  const CLOCK = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  const STATE_CLIP = 600;
  // Where LeetCode's pop-ups and menus render (Radix portals them to <body>).
  const POPUP =
    '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tablist],[data-radix-popper-content-wrapper]';
  const TIMER_LABEL = /^(start|pause|resume|reset|stopwatch|timer)$/i;
  const CONTROLS =
    'button,[role=button],[role=tab],[role=tabpanel],[role=switch],[role=checkbox],[role=option],[role=menuitem],input,select,[contenteditable],[tabindex]';
  const KEYS = /^([0-9]|Arrow(Up|Down|Left|Right)|Tab|Enter|Backspace|Delete|Escape)$/;

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

  // Tag and attributes only, no text: an ancestor's text can hold the problem or the code.
  const lite = (el) => {
    const attrs = {};
    for (const a of el.attributes || [])
      if (/^(data-|aria-|id$|class$|role$|type$)/.test(a.name)) attrs[a.name] = clip(a.value, 120);
    return { tag: el.tagName.toLowerCase(), attrs };
  };
  const ancestors = (el, n) => {
    const up = [];
    for (let a = el.parentElement; a && up.length < n; a = a.parentElement) up.push(lite(a));
    return up;
  };
  const ours = (el) => !!el.closest('aperture-lc-overlay,.monaco-editor');
  // The timer's toolbar: an element within 5 levels of one labelled like a timer control or showing a clock,
  // in a small subtree (never the whole page).
  function timerArea(el) {
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      if (n === document.body || n.querySelectorAll('*').length > 300) return false;
      const all = [n, ...n.querySelectorAll('*')];
      if (all.some((c) => TIMER_LABEL.test(c.getAttribute('aria-label') || ''))) return true;
      if (all.some((c) => c.childElementCount === 0 && CLOCK.test((c.textContent || '').trim())))
        return true;
    }
    return false;
  }
  const where = (el) =>
    !el || el.nodeType !== 1 || ours(el)
      ? null
      : el.closest(POPUP)
        ? 'popup'
        : timerArea(el)
          ? 'timer'
          : null;
  // A control as the duration fields need it: its value only for an input or select (never a textarea).
  const control = (el) => {
    const c = { ...lite(el), text: clip((el.textContent || '').trim(), 40), path: cssPath(el) };
    if (el.matches('input,select') && el.type !== 'password') {
      c.value = clip(String(el.value), 20);
      for (const k of ['min', 'max', 'step', 'inputmode', 'placeholder', 'name'])
        if (el.hasAttribute(k)) c[k] = clip(el.getAttribute(k), 40);
      c.disabled = !!el.disabled;
    }
    return c;
  };
  function dumpPopup(p, why) {
    log('dom.popup', {
      why,
      popup: lite(p),
      text: clip((p.textContent || '').trim(), 200),
      controls: [...p.querySelectorAll(CONTROLS)].slice(0, 40).map(control),
    });
  }
  // The outermost pop-up around an element (a dialog holding a tablist is one pop-up).
  const outer = (el) => {
    let p = el.closest(POPUP);
    for (let up = p && p.parentElement; up && (up = up.closest(POPUP)); up = up.parentElement)
      p = up;
    return p;
  };
  // One dump of the pop-up a press, a key or an input touched, once it has settled.
  const redump = new WeakMap();
  function settleDump(el, why) {
    const p = el.closest && outer(el);
    if (!p || redump.has(p)) return;
    redump.set(
      p,
      setTimeout(() => {
        redump.delete(p);
        if (p.isConnected) dumpPopup(p, why);
      }, 300),
    );
  }
  const timerNow = () => {
    try {
      return {
        timer: clip(localStorage.getItem('QD_TIMER_STATE'), STATE_CLIP),
        heartbeat: clip(localStorage.getItem('QD_TIMER_HEARTBEAT'), 40),
      };
    } catch {
      return { timer: null, heartbeat: null };
    }
  };

  function recordTimerProbes() {
    // pointerdown and mousedown too: a Radix tab switches on mousedown, never on click.
    for (const ev of ['pointerdown', 'mousedown', 'click'])
      document.addEventListener(
        ev,
        (e) => {
          const t = e.target;
          const at = where(t);
          if (!at) return;
          log('press', { ev, trusted: e.isTrusted, at, target: describe(t), up: ancestors(t, 3) });
          settleDump(t, ev);
        },
        true,
      );
    for (const ev of ['input', 'change'])
      document.addEventListener(
        ev,
        (e) => {
          const t = e.target;
          if (!t || !t.matches || !t.matches('input,select') || !where(t)) return;
          log('input', {
            ev,
            trusted: e.isTrusted,
            inputType: e.inputType || null,
            control: control(t),
          });
          settleDump(t, ev);
        },
        true,
      );
    document.addEventListener(
      'keydown',
      (e) => {
        if (!KEYS.test(e.key) || !where(e.target)) return;
        log('key', { key: e.key, trusted: e.isTrusted, target: lite(e.target) });
        settleDump(e.target, 'key');
      },
      true,
    );
    const vis = (ev, extra) =>
      log('vis', { ev, state: document.visibilityState, ...(extra || {}), ...timerNow() });
    document.addEventListener('visibilitychange', () => vis('visibilitychange'));
    for (const ev of ['pagehide', 'pageshow'])
      window.addEventListener(ev, (e) => vis(ev, { persisted: !!e.persisted }));
    for (const ev of ['focus', 'blur']) window.addEventListener(ev, () => vis(ev));
    window.addEventListener('storage', (e) => {
      const key = e.key == null ? null : SECRET.test(e.key) ? '[redacted]' : clip(e.key, 80);
      log('storage.event', {
        key,
        value: key === '[redacted]' ? '[redacted]' : clip(e.newValue, STATE_CLIP),
      });
    });
    // A 1 s tick that came late: how Safari throttles a hidden tab (only the late ones, so the log keeps room).
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (now - last > 1500) log('tick', { gapMs: now - last, state: document.visibilityState });
      last = now;
    }, 1000);
    // Pop-ups and alerts as they appear, and a pop-up's tabs or fields changing state with no event heard.
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          const el = m.target;
          if (el.nodeType === 1 && !ours(el) && el.closest(POPUP))
            log('dom.state', {
              el: lite(el),
              attr: m.attributeName,
              value: clip(el.getAttribute(m.attributeName), 40),
            });
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || ours(n)) continue;
          const opened = new Set(
            (n.matches(POPUP) ? [n] : [...n.querySelectorAll(POPUP)]).map(outer),
          );
          for (const p of opened) dumpPopup(p, 'open');
          const alerts = n.matches('[role=alert],[role=status],[aria-live]')
            ? [n]
            : [...n.querySelectorAll('[role=alert],[role=status],[aria-live]')];
          for (const a of alerts.slice(0, 5))
            log('dom.alert', { el: lite(a), text: clip((a.textContent || '').trim(), 120) });
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'aria-selected', 'aria-checked', 'value'],
    });
  }

  function startRecording() {
    if (recording) return;
    recording = true;
    recordTimerProbes();
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
          if (n.nodeType !== 1 || ours(n)) continue;
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
        const keys = [
          ...new Set(
            WATCH.concat(
              Object.keys(localStorage).filter(
                (k) => k.startsWith('qd_solve_session:') || k.startsWith('QD_'),
              ),
            ),
          ),
        ];
        for (const k of keys) {
          const v = SECRET.test(k) ? '[redacted]' : clip(localStorage.getItem(k), STATE_CLIP);
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
        log('sample', { clocks, timer: clip(localStorage.getItem('QD_TIMER_STATE'), STATE_CLIP) });
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

  // Whether a log() now would be kept: on, or not yet known (held until the setting is read).
  const wants = () => !known || enabled;
  (root.ApertureLC = root.ApertureLC || {}).debug = { log, dumpControls, describe, wants };
})(globalThis);
