// GitHub REST over global fetch. Not `gh api`: the App JWT must go as `Authorization: Bearer` (gh sends
// `token`, which GitHub rejects for a JWT — 401), and not curl (hook-denied against api.github.com; `/curl`
// pauses COI). Errors carry status + GitHub's message, never the headers.
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export function makeApi(bearer: string, fetchImpl: typeof fetch = fetch): Api {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${bearer}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aperture-cc-bot',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        // non-JSON body — keep the raw prefix
      }
      throw new GitHubError(res.status, `${method} ${path} → ${res.status} ${msg}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
}
