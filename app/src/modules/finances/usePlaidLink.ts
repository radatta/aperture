import type { LinkSuccessMetadata, PlaidError } from '@aperture/shared';

// Plaid Link, rolled our own instead of react-plaid-link (CONVENTIONS A/B: it's a script loader plus a
// Plaid.create wrapper, and it brings prop-types). The script comes from Plaid's CDN at runtime — Plaid
// requires that, and Workbox precaches only local files, so the service worker never intercepts it.

const LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidHandler {
  open(): void;
  destroy(): void;
}
interface PlaidGlobal {
  create(config: {
    token: string;
    onSuccess: (publicToken: string, metadata: LinkSuccessMetadata) => void;
    onExit: (error: (PlaidError & { display_message?: string | null }) | null) => void;
  }): PlaidHandler;
}
declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

let loading: Promise<void> | null = null;

// Inject the script at most once; a failed load is forgotten so the next attempt retries.
export function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LINK_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('Couldn’t load Plaid. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

// Test hook — module state survives between test files in the shared jsdom (test/setup.ts).
export function forgetPlaidScript(): void {
  loading = null;
}

export interface LinkHandlers {
  onSuccess: (publicToken: string, metadata: LinkSuccessMetadata) => void;
  onExit: (message: string | null) => void;
}

export async function openPlaidLink(token: string, handlers: LinkHandlers): Promise<void> {
  await loadPlaidScript();
  const handler = window.Plaid!.create({
    token,
    onSuccess: (publicToken, metadata) => {
      handler.destroy();
      handlers.onSuccess(publicToken, metadata);
    },
    onExit: (error) => {
      handler.destroy();
      handlers.onExit(error ? (error.display_message ?? error.error_message) : null);
    },
  });
  handler.open();
}

// Link's OAuth hand-off breaks inside an installed iOS PWA (react-plaid-link#396), so there Connect
// opens a normal browser tab instead. That tab has its own Cognito session — you may sign in again.
export function isStandalonePwa(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
  );
}
