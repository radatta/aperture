// A tiny module-level holder for the current access token. It exists because `api` (client.ts) is
// built at module load and can't read React context — the AuthProvider pushes the token here as it
// changes, and httpClient reads it per request. Stub mode never sets it (no network, no token).
let current: string | null = null;

export const setAuthToken = (token: string | null): void => {
  current = token;
};
export const getAuthToken = (): string | null => current;

// Same bridge, other direction: the BFF rejecting our token (401) means the session is gone in a way the
// OIDC client may not have noticed — a revoked token looks fine locally until the server says otherwise.
// AuthProvider registers the re-auth here; httpClient calls it. Unset in stub mode, where nothing 401s.
let reauth: (() => void) | null = null;

export const setReauthHandler = (fn: (() => void) | null): void => {
  reauth = fn;
};
export const notifyUnauthorized = (): void => reauth?.();
