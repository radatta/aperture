// The overlay, the badge and the coach's trace card — painting only (the decisions are lib/overlay-state.js and
// lib/coach.js, the actions content.js).
// Both live in closed shadow roots on hosts appended to <html>, outside React's #__next, so LeetCode's
// hydration never touches them, and no page script can read their state, their text or Aperture's words —
// whether the overlay and the badge show is all the page can see. The badge host also carries the pill a
// dismissed problem shows (Start a sitting) and the trace card's opener, under the same click rule as the
// overlay's buttons; the card is a third host, a panel that leaves the problem readable. Their
// styles are inline in the root, so neither side's CSS leaks into the other. A button acts only on a real
// click (isTrusted) on an overlay that is really showing: the host the last child of <html>, its style ours,
// nothing on it or <html> fading or moving it — checked at the click, and the host is put back and kept last
// on every poll. What that can't see (a page element in the browser's top layer, painted over the overlay
// but letting clicks through) is residual.
(function (root) {
  'use strict';
  const debug = (root.ApertureLC && root.ApertureLC.debug) || null;
  const STEP_TEXT = {
    send: 'Opening the sitting in Aperture…',
    reset: 'Resetting the editor…',
    confirm: 'Confirming the reset…',
    timer: 'Starting LeetCode’s timer…',
  };
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(12, 14, 18, 0.94); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
      padding: 16px; }
    .card { width: min(420px, 100%); border-radius: 14px; padding: 22px 22px 18px; background: #fbfaf7; color: #1c1d21;
      box-shadow: 0 18px 50px rgba(0,0,0,.35); }
    .kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #6a6c75; margin: 0 0 6px; }
    h1 { font-size: 20px; line-height: 1.25; margin: 0 0 6px; font-weight: 650; }
    .meta { font-size: 13px; color: #6a6c75; margin: 0 0 16px; }
    .msg { font-size: 14px; line-height: 1.4; margin: 0 0 16px; }
    .err { color: #b3261e; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    button { font-size: 15px; border-radius: 10px; padding: 10px 16px; border: 1px solid transparent; cursor: pointer; }
    .primary { background: #1f6f4a; color: #fff; font-weight: 600; flex: 1 1 auto; }
    .secondary { background: transparent; color: #1c1d21; border-color: #c9cad0; }
    .hint { font-size: 12px; color: #6a6c75; margin: 12px 0 0; }
    .badge { position: fixed; right: 12px; bottom: 12px; font-size: 12px; padding: 6px 10px; border-radius: 999px;
      background: rgba(28,29,33,.88); color: #f4f4f6; box-shadow: 0 4px 14px rgba(0,0,0,.25); max-width: min(460px, calc(100vw - 24px)); }
    .badge.warn { background: #8a5a00; } .badge.bad { background: #b3261e; }
    .pill { border: 0; cursor: pointer; font-weight: 600; }
    .opener { position: fixed; right: 12px; bottom: 46px; }
    .panel { position: fixed; right: 12px; bottom: 46px; width: min(380px, calc(100vw - 24px));
      max-height: calc(100vh - 70px); overflow: auto; border-radius: 14px; padding: 16px 16px 14px;
      background: #fbfaf7; color: #1c1d21; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
    .panel h1 { font-size: 16px; margin: 0 0 4px; }
    .panel label { display: block; font-size: 12px; color: #6a6c75; margin: 10px 0 4px; }
    .panel textarea { width: 100%; min-height: 44px; resize: vertical; font: 13px/1.35 ui-monospace, Menlo, monospace;
      padding: 6px 8px; border-radius: 8px; border: 1px solid #c9cad0; background: #fff; color: #1c1d21; }
    .panel .row { margin-top: 12px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1d1f24; color: #ececf0; } .kicker, .meta, .hint { color: #a3a5ae; }
      .secondary { color: #ececf0; border-color: #4a4c55; } .err { color: #ff8a80; } .primary { background: #2f8f62; }
      .panel { background: #1d1f24; color: #ececf0; } .panel label { color: #a3a5ae; }
      .panel textarea { background: #14161a; color: #ececf0; border-color: #4a4c55; }
    }`;

  const HOST_STYLE =
    'all: initial !important; position: fixed !important; z-index: 2147483647 !important; ' +
    'opacity: 1 !important; visibility: visible !important; pointer-events: auto !important; ' +
    'filter: none !important; transform: none !important; clip-path: none !important;';
  const styleOf = (shown, full) =>
    `${HOST_STYLE} inset: ${full ? '0' : 'auto'} !important; display: ${shown ? 'block' : 'none'} !important;`;
  function host(tag) {
    const el = document.createElement(tag);
    el.setAttribute('style', styleOf(false, false));
    const shadow = el.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    const body = document.createElement('div');
    shadow.appendChild(body);
    return { el, body };
  }
  // Last among <html>'s children, in this order, so nothing the page appends later stacks above them.
  function keepLast(els) {
    const parent = document.documentElement;
    if (!parent) return;
    let n = parent.lastElementChild;
    for (let i = els.length - 1; i >= 0; i--, n = n && n.previousElementSibling)
      if (n !== els[i]) return els.forEach((el) => parent.appendChild(el));
  }
  // At the click: is the overlay what the user sees? (getComputedStyle here is the isolated world's own.)
  function genuine(el, expected) {
    const html = document.documentElement;
    // Last among <html>'s children too: a later sibling at the same z-index would paint over it.
    if (!html || html.lastElementChild !== el || el.getAttribute('style') !== expected)
      return false;
    const bad = (cs, keys) => keys.some(([k, ok]) => cs[k] !== '' && cs[k] !== ok);
    return (
      !bad(getComputedStyle(el), [
        ['opacity', '1'],
        ['visibility', 'visible'],
        ['display', 'block'],
      ]) &&
      !bad(getComputedStyle(html), [
        ['opacity', '1'],
        ['filter', 'none'],
        ['transform', 'none'],
        ['visibility', 'visible'],
      ])
    );
  }
  function node(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const k of kids) el.append(k);
    return el;
  }

  // The trace card's fields: what each asks for, by lib/coach.js FIELDS key.
  const TRACE_FIELDS = [
    ['empty', 'Empty or smallest input'],
    ['boundary', 'A boundary case'],
    ['normal', 'A normal case'],
  ];

  function create(on) {
    const overlay = host('aperture-lc-overlay');
    const badge = host('aperture-lc-badge');
    const card = host('aperture-lc-coach');
    let overlayShown = false;
    let badgeShown = false;
    let cardShown = false;
    // What's typed in the card stops at the window, in the capture phase: registered at document_start, ahead
    // of LeetCode's own listeners, so its shortcuts (⌘↵ submits) never fire from the card, and no page
    // listener reads the text from the composed input, composition or clipboard events. Stopping propagation
    // leaves the typing itself alone. `keys` is the probe (README → Safari behaviour): key presses that reached
    // this guard, how many a listener ahead of it had already prevented, and input events — typing that
    // doesn't land shows here.
    const keys = { seen: 0, prevented: 0, inputs: 0 };
    const guard = (e) => {
      if (e.target !== card.el) return;
      if (e.type === 'keydown') {
        keys.seen++;
        if (e.defaultPrevented) keys.prevented++;
      } else if (e.type === 'input') keys.inputs++;
      e.stopImmediatePropagation();
    };
    for (const t of [
      'keydown',
      'keypress',
      'keyup',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'paste',
      'cut',
      'copy',
    ])
      window.addEventListener(t, guard, true);
    const btn = (cls, ap, text, fn) => {
      const b = node('button', { class: cls, 'data-ap': ap, type: 'button' }, text);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.isTrusted && genuine(overlay.el, styleOf(true, true))) fn();
      });
      return b;
    };

    function render(state, info) {
      overlay.body.replaceChildren();
      const show =
        state.phase === 'prompt' || state.phase === 'starting' || state.phase === 'failed';
      overlayShown = show;
      overlay.el.setAttribute('style', styleOf(show, show));
      overlay.body.setAttribute('data-phase', state.phase); // inside the closed root: for tests, not the page
      order();
      if (!show) return;
      const title = (info && info.title) || 'This problem';
      const meta = info && info.lang ? `Language: ${info.lang}` : '';
      const card = node('div', { class: 'card', role: 'dialog', 'aria-label': 'Aperture sitting' });
      card.append(node('p', { class: 'kicker' }, 'Aperture · LeetCode'), node('h1', {}, title));
      if (meta) card.append(node('p', { class: 'meta' }, meta));
      if (state.phase === 'prompt') {
        card.append(
          node(
            'div',
            { class: 'row' },
            btn('primary', 'start', 'Start', on.start),
            btn('secondary', 'look', 'Just looking', on.dismiss),
          ),
          node(
            'p',
            { class: 'hint' },
            'Start opens a sitting in Aperture, then resets the editor and starts LeetCode’s timer.',
          ),
        );
      } else if (state.phase === 'starting') {
        card.append(
          node('p', { class: 'msg', 'data-ap': 'step' }, STEP_TEXT[state.step] || 'Starting…'),
        );
        if (state.retrying)
          card.append(node('p', { class: 'hint' }, `Retrying — ${state.retrying}`));
      } else {
        card.append(
          node('p', { class: 'msg err', 'data-ap': 'reason' }, state.reason || 'Start failed.'),
        );
        const row = node('div', { class: 'row' }, btn('primary', 'retry', 'Retry', on.retry));
        // Open: a click step failed after Aperture said yes — Continue keeps the sitting, uncleared.
        // Not open: Aperture refused, and nothing was touched.
        // Past the reset and its confirm, only LeetCode's timer is missing: the editor was cleared.
        const cleared = state.step === 'timer';
        if (state.open)
          row.append(
            btn(
              'secondary',
              'continue',
              cleared ? 'Continue without the timer' : 'Continue without a clear',
              on.continue,
            ),
          );
        else row.append(btn('secondary', 'look', 'Just looking', on.dismiss));
        card.append(row);
        if (state.open)
          card.append(
            node(
              'p',
              { class: 'hint' },
              cleared
                ? 'The sitting is open in Aperture and the editor was cleared; LeetCode’s timer wasn’t restarted.'
                : 'The sitting is open in Aperture; the editor wasn’t cleared.',
            ),
          );
      }
      const scrim = node('div', { class: 'scrim' }, card);
      overlay.body.append(scrim);
      probeScrim(scrim);
    }
    // Once a page load: whether Safari takes the scrim's blur under either name, and what it computed (a
    // closed shadow root on a fixed host — README → Safari behaviour).
    let probed = false;
    function probeScrim(el) {
      if (probed || !debug) return;
      probed = true;
      const sup = (prop) => {
        try {
          return CSS.supports(prop, 'blur(20px)');
        } catch {
          return null;
        }
      };
      let cs = null;
      try {
        cs = getComputedStyle(el);
      } catch {}
      debug.log('scrim', {
        supports: { std: sup('backdrop-filter'), webkit: sup('-webkit-backdrop-filter') },
        computed: {
          std: (cs && cs.backdropFilter) || null,
          webkit: (cs && cs.webkitBackdropFilter) || null,
          background: (cs && cs.backgroundColor) || null,
        },
      });
    }

    // text null hides it; tone: '' | 'warn' | 'bad'; action 'reopen' makes it the pill, a button; 'trace' adds
    // the trace card's opener above it.
    // An unchanged repaint keeps the nodes: a pill rebuilt between mousedown and mouseup would lose the click.
    // What's painted ('status', the pill's text, or null). The status line is updated in place and the opener
    // kept while it's offered, so the 5 s repaint never swaps a node between mousedown and mouseup.
    let painted = null;
    let statusEl = null;
    let openerEl = null;
    function opener() {
      const b = node(
        'button',
        { class: 'badge pill opener', 'data-ap': 'trace-open', type: 'button' },
        'Trace 3 inputs',
      );
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.isTrusted && genuine(badge.el, styleOf(true, false))) on.openCard();
      });
      return b;
    }
    function setBadge(text, tone, action) {
      badgeShown = !!text;
      badge.el.setAttribute('style', styleOf(badgeShown, false));
      order();
      if (!text || action === 'reopen') {
        const key = text ? `pill:${text}` : null;
        if (key === painted) return;
        painted = key;
        statusEl = openerEl = null;
        badge.body.replaceChildren();
        if (!text) return;
        const pill = node(
          'button',
          { class: 'badge pill', 'data-ap': 'reopen', type: 'button' },
          text,
        );
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          const ok = e.isTrusted && genuine(badge.el, styleOf(true, false));
          // A probe: a click Safari's checks refuse would otherwise do nothing, silently.
          if (debug) debug.log('pill', { trusted: e.isTrusted, ok });
          if (ok) on.reopen();
        });
        return badge.body.append(pill);
      }
      if (painted !== 'status') {
        painted = 'status';
        badge.body.replaceChildren();
        statusEl = node('div', { 'data-ap': 'badge', role: 'status' });
        openerEl = null;
        badge.body.append(statusEl);
      }
      if (statusEl.textContent !== text) statusEl.textContent = text;
      statusEl.className = `badge ${tone || ''}`;
      if (action === 'trace' && !openerEl) badge.body.append((openerEl = opener()));
      else if (action !== 'trace' && openerEl) {
        openerEl.remove();
        openerEl = null;
      }
    }
    // LeetCode may rebuild <html>'s children; the content script's poll calls this to put them back.
    // The shown one last (the overlay over the badge), as soon as either changes and on every poll.
    // Hidden hosts first, then the shown ones from the bottom up: badge, card, overlay.
    function order() {
      const hosts = [
        [badge.el, badgeShown],
        [card.el, cardShown],
        [overlay.el, overlayShown],
      ];
      keepLast([...hosts.filter((h) => !h[1]), ...hosts.filter((h) => h[1])].map((h) => h[0]));
    }
    const ensureAttached = () => {
      overlay.el.setAttribute('style', styleOf(overlayShown, overlayShown));
      badge.el.setAttribute('style', styleOf(badgeShown, false));
      card.el.setAttribute('style', styleOf(cardShown, false));
      order();
    };

    // The trace card: open → the three fields and Trace / Skip; null → hidden. Trace hands content.js what was
    // typed; the buttons act under the real-click rule, on this host.
    function renderCard(open) {
      if (open === cardShown) return order();
      cardShown = open;
      card.el.setAttribute('style', styleOf(open, false));
      card.body.replaceChildren();
      order();
      if (!open) return;
      Object.assign(keys, { seen: 0, prevented: 0, inputs: 0 });
      const fields = {};
      const panel = node('div', {
        class: 'panel',
        role: 'dialog',
        'aria-label': 'Trace before you submit',
      });
      panel.append(
        node('p', { class: 'kicker' }, 'Aperture · before you submit'),
        node('h1', {}, 'Trace 3 inputs by hand'),
        node(
          'p',
          { class: 'meta' },
          'Walk your code over each, line by line. A word or two is enough.',
        ),
      );
      for (const [k, label] of TRACE_FIELDS) {
        const id = `ap-trace-${k}`;
        const ta = node('textarea', { id, 'data-ap': `trace-${k}`, maxlength: '300', rows: '2' });
        fields[k] = ta;
        panel.append(node('label', { for: id }, label), ta);
      }
      const act = (fn) => (e) => {
        e.stopPropagation();
        if (!(e.isTrusted && genuine(card.el, styleOf(true, false)))) return;
        fn();
      };
      const traced = node(
        'button',
        { class: 'primary', 'data-ap': 'trace', type: 'button' },
        'Traced',
      );
      traced.addEventListener(
        'click',
        act(() => on.trace(values())),
      );
      const skip = node(
        'button',
        { class: 'secondary', 'data-ap': 'skip', type: 'button' },
        'Skip',
      );
      skip.addEventListener(
        'click',
        act(() => on.skip()),
      );
      panel.append(
        node('div', { class: 'row' }, traced, skip),
        node('p', { class: 'hint' }, 'Then click Submit again — Aperture never submits for you.'),
      );
      card.body.append(panel);
      try {
        fields.empty.focus({ preventScroll: true }); // straight to typing, out of LeetCode's editor
      } catch {}
      function values() {
        const out = {};
        for (const [k] of TRACE_FIELDS) out[k] = fields[k].value;
        return out;
      }
      cardValues = values;
    }
    let cardValues = () => ({});
    // What the card holds now (a Submit clicked with the card open takes it as the trace), and the probe.
    const cardState = () => ({ values: cardShown ? cardValues() : null, keys: { ...keys } });
    // Whether a node is one of our hosts (a click there is never LeetCode's).
    const owns = (el) => el === overlay.el || el === badge.el || el === card.el;
    return { render, setBadge, ensureAttached, renderCard, cardState, owns };
  }

  (root.ApertureLC = root.ApertureLC || {}).overlay = { create, STEP_TEXT };
})(globalThis);
