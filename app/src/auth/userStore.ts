import { WebStorageStateStore } from 'oidc-client-ts';

// Where the OIDC client keeps the signed-in user (id, access, and — the one that matters — refresh
// token). oidc-client-ts defaults this to sessionStorage, which the browser drops when the browsing
// context goes away, and the OS reclaims a standalone PWA's process routinely. That discarded a
// still-valid refresh token and forced a full Hosted-UI sign-in every day or so. localStorage survives
// relaunch, so signinSilent finds the refresh token and renews against the token endpoint — no iframe,
// so no silent_redirect_uri and no dependence on the Hosted UI's own session cookie (fixed at 1 hour,
// and a token refresh doesn't renew it). Lazy: stub mode never touches window.
let store: WebStorageStateStore | undefined;

export const getUserStore = (): WebStorageStateStore =>
  (store ??= new WebStorageStateStore({ store: window.localStorage }));
