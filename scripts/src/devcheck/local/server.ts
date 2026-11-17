// The local check's two processes — the local server (lambdas/src/local/serve.ts) and Vite — started on
// kernel-chosen loopback ports and stopped by the PID this file holds (never by pattern: CLAUDE.md).
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { DevcheckError } from '../errors';

export interface Proc {
  pid: number;
  stop(): Promise<void>;
  killNow(): void; // sync, for process 'exit': SIGKILL only while the child is still ours (not reaped)
}

const fail = (msg: string) => new DevcheckError('LOCAL_SERVER_FAILED', msg);

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

function asProc(child: ChildProcess, name: string): Proc {
  if (!child.pid) throw fail(`${name} did not start`);
  const pid = child.pid;
  let gone = false;
  const exited = new Promise<void>((r) =>
    child.once('exit', () => {
      gone = true;
      r();
    }),
  );
  return {
    pid,
    killNow() {
      if (gone) return;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      process.kill(pid, 'SIGTERM');
      const t = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, 5_000);
      await exited;
      clearTimeout(t);
    },
  };
}

// The local server: node + tsx's loader over the lambdas source, its own env only (no AWS variables can leak
// in from the shell). Resolves with the port from its one ready line.
export async function startLocalServer(o: {
  worktree: string;
  track: (p: Proc) => void;
  env: Record<string, string>;
  logPath: string;
}): Promise<{ port: number; proc: Proc }> {
  const loader = import.meta.resolve('tsx/esm');
  const entry = join(o.worktree, 'lambdas', 'src', 'local', 'serve.ts');
  const child = spawn(process.execPath, ['--import', loader, entry], {
    cwd: join(o.worktree, 'lambdas'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TZ: 'UTC',
      STAGE: 'dev',
      ...o.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'], // stdin held open: it closes when the harness dies, however it dies
  });
  const log = createWriteStream(o.logPath);
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const proc = asProc(child, 'the local server');
  o.track(proc);
  const port = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(fail('the local server sent no ready line in 30 s')), 30_000);
    let buf = '';
    const onData = (b: Buffer) => {
      buf += String(b);
      const m = /"ready":true,"port":(\d+)/.exec(buf);
      if (!m) return;
      clearTimeout(t);
      child.stdout!.off('data', onData);
      res(Number(m[1]));
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(t);
      rej(fail(`the local server exited (${code}) before it was ready — see ${o.logPath}`));
    });
  }).catch(async (err: unknown) => {
    await proc.stop();
    throw err;
  });
  return { port, proc };
}

// Vite's own lines saying it reloaded or updated the page (a watched edit, the dep optimizer's late discovery, a
// restart) — what a step failing near one failed on.
const RELOAD =
  /page reload|optimized dependencies changed\. reloading|hmr update|server restarted/i;
export const viteReloads = (log: string): string[] =>
  stripVTControlCharacters(log)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => RELOAD.test(l));

// Vite dev over the worktree's app, in http mode against the local Cognito stand-in, proxying the edge paths
// to the local server (app/vite.config.ts → APERTURE_LOCAL_EDGE). Ready once it serves the shell. Never watching
// (APERTURE_NO_WATCH): an edit mid-run would reload the page under a step.
export async function startVite(o: {
  worktree: string;
  track: (p: Proc) => void;
  port: number;
  edgePort?: number; // none: the stub app (in-memory data, no auth) — the iOS probe check's
  env: Record<string, string>;
  logPath: string;
}): Promise<Proc> {
  const app = join(o.worktree, 'app');
  const vite = join(app, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [
      vite,
      '--host',
      '127.0.0.1',
      '--port',
      String(o.port),
      '--strictPort',
      '--clearScreen',
      'false',
    ],
    {
      cwd: app,
      env: o.edgePort
        ? {
            ...process.env,
            ...o.env,
            APERTURE_LOCAL_EDGE: `http://127.0.0.1:${o.edgePort}`,
            APERTURE_NO_WATCH: '1',
          }
        : { ...process.env, VITE_API_MODE: 'stub', ...o.env, APERTURE_NO_WATCH: '1' }, // over any app/.env.local
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log = createWriteStream(o.logPath);
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const proc = asProc(child, 'vite');
  o.track(proc);
  const origin = `http://127.0.0.1:${o.port}`;
  // Ours only once this Vite has printed its own URL: the port is free when probed but not reserved, so another
  // lane's Vite could take it first, and a fetch alone would then succeed against that lane's app.
  let own = false;
  let out = '';
  const onOut = (b: Buffer) => {
    out += stripVTControlCharacters(String(b));
    if (!out.includes(`${origin}/`)) return;
    own = true;
    child.stdout!.off('data', onOut);
  };
  child.stdout!.on('data', onOut);
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw fail(`vite exited (${child.exitCode ?? child.signalCode}) — see ${o.logPath}`);
    try {
      if (own) {
        const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) });
        if (res.ok && child.exitCode === null) return proc;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > 60_000) {
      await proc.stop();
      throw fail(`vite served nothing at ${origin} in 60 s — see ${o.logPath}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
