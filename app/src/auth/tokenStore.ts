// A tiny module-level holder for the current access token. It exists because `api` (client.ts) is
// built at module load and can't read React context — the AuthProvider pushes the token here as it
// changes, and httpClient reads it per request. Stub mode never sets it (no network, no token).
let current: string | null = null;

export const setAuthToken = (token: string | null): void => {
  current = token;
};
export const getAuthToken = (): string | null => current;
