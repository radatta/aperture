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
