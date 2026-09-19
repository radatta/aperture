import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests (RTL auto-cleanup without enabling vitest globals).
afterEach(() => cleanup());

// jsdom doesn't implement ResizeObserver, and AppShell uses one to size the bottom dock's content
// reserve. A no-op stub is the honest shape here: jsdom has no layout engine, so a real
// implementation would only ever report 0 anyway. Dock clearance is verified in the browser, not
// in jsdom.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has HTMLDialogElement but not showModal()/close() (there's no top layer). Stub them to toggle
// the `open` property so the Modal primitive, which drives a <dialog> imperatively, works under test.
// Real modal behavior (focus trap, ::backdrop, native Escape→cancel) is verified in the browser.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
