// Test doubles for the bot: a scripted GitHub API, a git/gh runner, and a manual clock. No network — every
// test talks to these (COI: no sockets from tests).
import type { Api } from './api.ts';
import { GitHubError } from './api.ts';
import type { Clock } from './dispatch.ts';
import type { Run } from './sh.ts';

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}
type Handler = (call: Call) => unknown;

// Routes `METHOD path-prefix` → handler; a handler may throw GitHubError. Unrouted calls fail the test.
export function fakeApi(routes: Record<string, Handler>): { api: Api; calls: Call[] } {
  const calls: Call[] = [];
  const api = (async (method: string, path: string, body?: unknown) => {
    const call = { method, path, body };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => `${method} ${path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unrouted ${method} ${path}`);
    return routes[key]?.(call);
  }) as Api;
  return { api, calls };
}

export const ghError = (status: number) => new GitHubError(status, `HTTP ${status}`);

// git/gh by argv: the first matching prefix answers (string, or a thrower).
export function fakeRun(answers: [string, string | (() => string)][]): {
  run: Run;
  calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
} {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts?.env });
    const line = [cmd, ...args].join(' ');
    const hit = answers.find(([prefix]) => line.startsWith(prefix));
    if (!hit) throw new Error(`unscripted: ${line}`);
    return typeof hit[1] === 'function' ? hit[1]() : hit[1];
  }) as Run;
  return { run, calls };
}

export function fakeClock(start = Date.parse('2026-10-13T20:00:00Z')): Clock & { t: number } {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}
