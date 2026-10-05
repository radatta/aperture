import { afterAll, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { queryClient } from '../data/queryClient';
import { setAuthToken, setReauthHandler } from '../auth/tokenStore';
import { forgetStubBlobs } from '../data/attachmentTransport';
import { resetInputModality } from '../lib/useDisclosure';
import { forgetPlaidScript } from '../modules/finances/usePlaidLink';
import { forgetAudio } from '../modules/pomodoro/chime';

// Files share one jsdom and one module graph (isolate: false), so whatever a test leaves behind is the
// next file's starting state. One hook, not several: after-hooks run in reverse, and the unmount (RTL
// cleanup, without vitest globals) must come before the resets.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  queryClient.clear();
  setAuthToken(null);
  setReauthHandler(null);
  forgetStubBlobs();
  resetInputModality();
  forgetPlaidScript();
  forgetAudio();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.history.replaceState(null, '', '/');
});

// TanStack delivers observer updates on a setTimeout(0), so a test's last update can still be queued
// after it unmounts. Drain one macrotask per file so it lands while jsdom is alive — after the last file
// the shared jsdom is torn down immediately, and the straggler hits React with no `window`. Covers one
// hop only — a straggler that schedules another timer, or a longer timer left running, isn't drained.
afterAll(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

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
