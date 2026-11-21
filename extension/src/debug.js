// Debug mode (Options → Debug mode): a recorder for finding LeetCode's controls — what was clicked, which
// dialogs appeared, how LeetCode's timer state moved — kept in storage.local.debugLog for Options → Export.
// Off, it records nothing. It never records code, request bodies or tokens: wire entries are sizes only,
// storage keys that look like credentials are redacted, another key's value is kept only for LeetCode's timer and
// session keys, a field's value only when it is a short number, and nothing inside the code editor is described.
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
    'button,[role=button],[role=tab],[role=tabpanel],[role=switch],[role=checkbox],[role=radio],[role=spinbutton],[role=option],[role=menuitem],input,select,[contenteditable],[tabindex]';
  const KEYS = /^([0-9]|Arrow(Up|Down|Left|Right)|Tab|Enter|Backspace|Delete|Escape)$/;
  const LIVE = '[role=alert],[role=status],[aria-live]';
  // Where typed text lives: the code editor, an editable region, a textarea. Never described, nor any text holding one.
  const EDITOR =
    '.monaco-editor,.monaco-aria-container,[contenteditable]:not([contenteditable=false]),textarea';
  const FIELDS = `input,select,${EDITOR}`;
  const holds = (el, q) => !!(el.matches && (el.matches(q) || el.querySelector(q)));
  // The keys whose values are kept: LeetCode's timer (its heartbeat aside: it changes every second, and `vis` carries
  // it), its solve sessions and the language. Any other key logs its length alone — it could hold a code draft.
  const valued = (k) =>
    (/^QD_TIMER_/.test(k) && k !== 'QD_TIMER_HEARTBEAT') ||
    k.startsWith('qd_solve_session:') ||
    k === 'global_lang';
  // This page, on every entry: two tabs write one log (the session's step 11).
  const PAGE = Math.random().toString(36).slice(2, 8);
  const TAIL = 'debugTail.';

  let known = false;
  let enabled = false;
  let early = [];
  let fresh = [];
  let recording = false;

  const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
  let seq = 0;
  function log(type, data) {
    // The page and its sequence last, so no entry's own fields (doc.keep's `n`) overwrite them.
    const e = { t: Date.now(), type, ...(data || {}), pg: PAGE, sq: seq++ };
    if (!known) {
      if (early.length < 200) early.push(e);
    } else if (enabled) fresh.push(e);
  }
  // Every 2 s: the log read, this page's batch and any tails added, written back. Under a Web Lock (origin-wide, so two
  // LeetCode tabs take turns — inferred from the spec, unproven in Safari's isolated world); without one, as before.
  async function write(batch) {
    const got = await api.storage.local.get(null);
    const tails = Object.keys(got).filter((k) => k.startsWith(TAIL));
    const seen = new Set();
    const all = (Array.isArray(got.debugLog) ? got.debugLog : [])
      .concat(...tails.map((k) => (Array.isArray(got[k]) ? got[k] : [])), batch)
      .filter((e) => {
        const id = e && e.pg != null && e.sq != null ? `${e.pg}.${e.sq}` : null; // a tail folded twice
        if (id === null) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => a.t - b.t);
    await api.storage.local.set({ debugLog: all.slice(-MAX) });
    if (tails.length) await api.storage.local.remove(tails);
  }
  // The batch in flight stays in `pending` until written, so a page leaving mid-write still saves it (flushTail).
  let pending = [];
  setInterval(async () => {
    if (!fresh.length || pending.length) return;
    pending = fresh;
    fresh = [];
    const batch = pending;
    try {
      const locks = globalThis.navigator && navigator.locks;
      if (locks) await locks.request('aperture-debug-log', () => write(batch));
      else await write(batch);
    } catch {
      // A lock refused (an isolated-world quirk) writes unlocked rather than dropping the batch.
      try {
        await write(batch);
      } catch {}
    }
    pending = [];
  }, 2000);
  // Leaving (a reload, a close): one write with no read first, to its own key, which the next write folds in — the page
  // may be gone before a read comes back.
  let tails = 0;
  function flushTail() {
    if (!fresh.length && !pending.length) return;
    const batch = pending.concat(fresh);
    fresh = [];
    try {
      api.storage.local.set({ [`${TAIL}${PAGE}.${tails++}`]: batch }).catch(() => {});
    } catch {}
  }

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
    const field = holds(el, FIELDS); // a field's value sits in its html; typed text in its text
    return {
      tag: el.tagName.toLowerCase(),
      text: holds(el, EDITOR) ? null : clip((el.textContent || '').trim(), 60),
      attrs,
      icon: svg
        ? {
            dataIcon: clip(svg.getAttribute('data-icon'), 60),
            class: clip(svg.getAttribute('class'), 120),
          }
        : null,
      html: field ? null : clip(el.outerHTML, 400),
      path: cssPath(el),
    };
  }
  // On a failed Start step: every control near where LeetCode's reset and timer live, so the export names them.
  function dumpControls() {
    const pick = (q) => [...document.querySelectorAll(q)].filter(shown).slice(0, 30).map(describe);
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
  const shown = (el) =>
    !ours(el) && !el.closest(EDITOR) && !(el.matches('input') && el.type === 'hidden');
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
  // A field's value only when it reads like a duration (a short number); else its length. Never a hidden field, a
  // password or one named like a credential.
  const DURATION = /^[\d:.\s]{0,8}$/;
  const secretField = (el) =>
    el.type === 'password' ||
    ['name', 'id', 'autocomplete', 'aria-label'].some((a) => SECRET.test(el.getAttribute(a) || ''));
  // A control as the duration fields need it (editable text never reaches here: `shown`).
  const control = (el) => {
    const c = {
      ...lite(el),
      text: holds(el, EDITOR) ? null : clip((el.textContent || '').trim(), 40),
      path: cssPath(el),
    };
    if (el.matches('input,select') && !secretField(el)) {
      const v = String(el.value);
      // A select's value is one of LeetCode's own options, never typed.
      if (DURATION.test(v) || el.matches('select')) c.value = clip(v, 40);
      else c.valueLen = v.length;
      if (el.type === 'checkbox' || el.type === 'radio') c.checked = !!el.checked;
      for (const k of ['min', 'max', 'step', 'inputmode', 'placeholder', 'name'])
        if (el.hasAttribute(k)) c[k] = clip(el.getAttribute(k), 40);
      c.disabled = !!el.disabled;
    }
    return c;
  };
  function dumpPopup(p, why) {
    const editor = holds(p, EDITOR);
    log('dom.popup', {
      why,
      popup: lite(p),
      ...(editor
        ? { text: null, hasEditor: true }
        : { text: clip((p.textContent || '').trim(), 200) }),
      controls: [...p.querySelectorAll(CONTROLS)].filter(shown).slice(0, 40).map(control),
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
    // pointerdown, mousedown and focusin too: a Radix tab switches on mousedown or focus, never on click.
    for (const ev of ['pointerdown', 'mousedown', 'focusin', 'click'])
      document.addEventListener(
        ev,
        (e) => {
          if (!enabled) return;
          const t = e.target;
          const at = where(t);
          if (!at) return;
          // The control pressed, in full; the element hit (often its <svg>) and three ancestors, tag and attributes only.
          const ctl = t.closest(CONTROLS);
          log('press', {
            ev,
            trusted: e.isTrusted,
            at,
            target:
              ctl && shown(ctl)
                ? ctl.matches('input,select')
                  ? control(ctl)
                  : describe(ctl)
                : null,
            hit: lite(t),
            up: ancestors(t, 3),
          });
          settleDump(t, ev);
        },
        true,
      );
    for (const ev of ['input', 'change'])
      document.addEventListener(
        ev,
        (e) => {
          const t = e.target;
          if (!enabled || !t || !t.matches || !t.matches('input,select') || !where(t)) return;
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
        const t = e.target;
        if (!enabled || !KEYS.test(e.key) || !where(t) || !shown(t)) return;
        if (t.matches && t.matches('input') && secretField(t)) return; // a password's or a code's digits
        log('key', { key: e.key, trusted: e.isTrusted, target: lite(t) });
        settleDump(t, 'key');
      },
      true,
    );
    const vis = (ev, extra) =>
      enabled &&
      log('vis', { ev, state: document.visibilityState, ...(extra || {}), ...timerNow() });
    document.addEventListener('visibilitychange', () => {
      vis('visibilitychange');
      if (document.visibilityState === 'hidden') flushTail();
    });
    window.addEventListener('pagehide', (e) => {
      vis('pagehide', { persisted: !!e.persisted });
      flushTail();
    });
    window.addEventListener('pageshow', (e) => vis('pageshow', { persisted: !!e.persisted }));
    for (const ev of ['focus', 'blur']) window.addEventListener(ev, () => vis(ev));
    // Another tab's localStorage writes (never this page's own). The heartbeat is skipped (every second, in `vis`).
    window.addEventListener('storage', (e) => {
      if (!enabled || e.key === 'QD_TIMER_HEARTBEAT') return;
      if (e.key == null) return void log('storage.event', { key: null, cleared: true });
      if (SECRET.test(e.key))
        return void log('storage.event', { key: '[redacted]', value: '[redacted]' });
      const key = clip(e.key, 80);
      log(
        'storage.event',
        valued(e.key)
          ? { key, value: clip(e.newValue, STATE_CLIP) }
          : { key, valueLen: e.newValue == null ? null : e.newValue.length },
      );
    });
    // A 1 s tick that came late: how Safari throttles a hidden tab (only the late ones, so the log keeps room).
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (now - last > 1500) log('tick', { gapMs: now - last, state: document.visibilityState });
      last = now;
    }, 1000);
    // Pop-ups and alerts as they appear, a live region or the tab's title taking new text, and a pop-up's tabs or
    // fields changing state (a class only on a control: a tab may switch by its classes alone).
    const alert = (a) =>
      log('dom.alert', { el: lite(a), text: clip((a.textContent || '').trim(), 120) });
    // A clock ticking in a live region or the title would log every second: only a change of shape counts.
    const shape = (x) => (x || '').trim().replace(/\d/g, '#');
    const lastShape = new WeakMap();
    let titleShape = shape(document.title);
    const reshaped = (a) => {
      const sh = shape(a.textContent);
      if (lastShape.get(a) === sh) return false;
      lastShape.set(a, sh);
      return true;
    };
    const live = (node) => {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const a = el && el.closest(LIVE);
      return a && !ours(a) && !a.closest(EDITOR) ? a : null;
    };
    new MutationObserver((muts) => {
      if (!enabled) return;
      const changed = new Set();
      for (const m of muts) {
        if (m.type === 'attributes') {
          const el = m.target;
          if (el.nodeType !== 1 || ours(el) || el.closest(EDITOR) || !el.closest(POPUP)) continue;
          if (m.attributeName === 'class' && !el.matches(CONTROLS)) continue;
          const v = el.getAttribute(m.attributeName);
          // React mirrors a field's typed value into its value attribute: the field rule, as control() reads it.
          if (m.attributeName === 'value') {
            if (secretField(el)) continue;
            const keep = v == null || DURATION.test(v) || el.matches('select,option');
            log('dom.state', {
              el: lite(el),
              attr: 'value',
              ...(keep ? { value: clip(v, 40) } : { valueLen: v.length }),
            });
            continue;
          }
          log('dom.state', {
            el: lite(el),
            attr: m.attributeName,
            value: clip(v, m.attributeName === 'class' ? 160 : 40),
          });
          continue;
        }
        const tgt = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (tgt && tgt.closest('title')) {
          if (shape(document.title) !== titleShape) {
            titleShape = shape(document.title);
            log('title', { text: clip(document.title, 80) });
          }
          continue;
        }
        // Text into a live region already on the page (the accessible way to announce, perhaps the alarm at 0).
        const a = live(m.target);
        if (a) changed.add(a);
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || ours(n)) continue;
          const opened = new Set(
            (n.matches(POPUP) ? [n] : [...n.querySelectorAll(POPUP)])
              .filter((p) => !ours(p))
              .map(outer),
          );
          for (const p of opened) dumpPopup(p, 'open');
          const alerts = n.matches(LIVE) ? [n] : [...n.querySelectorAll(LIVE)];
          for (const x of alerts.filter((x) => !ours(x) && !x.closest(EDITOR)).slice(0, 5)) {
            changed.delete(x);
            lastShape.set(x, shape(x.textContent));
            alert(x);
          }
        }
      }
      for (const a of [...changed].filter(reshaped).slice(0, 5)) alert(a);
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-state',
        'aria-selected',
        'aria-checked',
        'aria-pressed',
        'aria-expanded',
        'aria-valuenow',
        'disabled',
        'value',
        'class',
      ],
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
        if (el && shown(el)) log('click', describe(el));
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
          // Tag and attributes, and its text only when it holds no field or editor (a form's values sit in its html).
          if (d)
            log('dom.dialog', {
              dialog: {
                ...lite(d),
                text: holds(d, FIELDS) ? null : clip((d.textContent || '').trim(), 60),
                path: cssPath(d),
              },
              buttons: [...d.querySelectorAll('button')].filter(shown).slice(0, 10).map(describe),
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
          if (k === 'QD_TIMER_HEARTBEAT') continue; // every second; `vis` carries it
          const raw = localStorage.getItem(k);
          const e = SECRET.test(k)
            ? { key: k, value: '[redacted]' }
            : valued(k)
              ? { key: k, value: clip(raw, STATE_CLIP) }
              : { key: k, valueLen: raw == null ? null : raw.length };
          const seen = JSON.stringify(e);
          if (last[k] !== seen) {
            last[k] = seen;
            log('storage', e);
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
        log('sample', {
          clocks,
          state: document.visibilityState,
          timer: clip(localStorage.getItem('QD_TIMER_STATE'), STATE_CLIP),
        });
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
