// The overlay and the badge — painting only (the decisions are lib/overlay-state.js, the actions content.js).
// Both live in open shadow roots on hosts appended to <html>, outside React's #__next, so LeetCode's
// hydration never touches them; their styles are inline in the root, so neither side's CSS leaks into the other.
(function (root) {
  'use strict';
  const STEP_TEXT = {
    reset: 'Resetting the editor…',
    confirm: 'Confirming the reset…',
    timer: 'Starting LeetCode’s timer…',
    send: 'Opening the sitting in Aperture…',
  };
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(12, 14, 18, 0.62); backdrop-filter: blur(3px); padding: 16px; }
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
    @media (prefers-color-scheme: dark) {
      .card { background: #1d1f24; color: #ececf0; } .kicker, .meta, .hint { color: #a3a5ae; }
      .secondary { color: #ececf0; border-color: #4a4c55; } .err { color: #ff8a80; } .primary { background: #2f8f62; }
    }`;

  function host(tag) {
    const el = document.createElement(tag);
    el.setAttribute('style', 'all: initial; position: fixed; z-index: 2147483647; inset: auto;');
    const shadow = el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const body = document.createElement('div');
    shadow.appendChild(body);
    return { el, body };
  }
  const attach = (el) => {
    const parent = document.documentElement;
    if (parent && !el.isConnected) parent.appendChild(el);
  };
  function node(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const k of kids) el.append(k);
    return el;
  }

  function create(on) {
    const overlay = host('aperture-lc-overlay');
    const badge = host('aperture-lc-badge');
    const btn = (cls, ap, text, fn) => {
      const b = node('button', { class: cls, 'data-ap': ap, type: 'button' }, text);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };

    function render(state, info) {
      overlay.body.replaceChildren();
      const show =
        state.phase === 'prompt' || state.phase === 'starting' || state.phase === 'failed';
      overlay.el.style.inset = show ? '0' : 'auto';
      overlay.el.setAttribute('data-phase', state.phase); // kept on the page even hidden: the state is readable
      overlay.el.style.display = show ? 'block' : 'none';
      attach(overlay.el);
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
            'Start resets the editor, starts LeetCode’s timer and opens a sitting in Aperture.',
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
        if (state.step !== 'send')
          row.append(btn('secondary', 'anyway', 'Start anyway (no clear)', on.startAnyway));
        row.append(btn('secondary', 'look', 'Just looking', on.dismiss));
        card.append(row);
      }
      overlay.body.append(node('div', { class: 'scrim' }, card));
    }

    // text null hides it; tone: '' | 'warn' | 'bad'
    function setBadge(text, tone) {
      badge.body.replaceChildren();
      if (!text) {
        badge.el.style.display = 'none';
        return;
      }
      badge.el.style.display = 'block';
      attach(badge.el);
      badge.body.append(
        node('div', { class: `badge ${tone || ''}`, 'data-ap': 'badge', role: 'status' }, text),
      );
    }
    // LeetCode may rebuild <html>'s children; the content script's poll calls this to put them back.
    const ensureAttached = () => {
      attach(overlay.el);
      if (badge.el.style.display === 'block') attach(badge.el);
    };
    return { render, setBadge, ensureAttached };
  }

  (root.ApertureLC = root.ApertureLC || {}).overlay = { create, STEP_TEXT };
})(globalThis);
