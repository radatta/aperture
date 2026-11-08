// The local check's two processes — the local server (lambdas/src/local/serve.ts) and Vite — started on
// kernel-chosen loopback ports and stopped by the PID this file holds (never by pattern: CLAUDE.md).
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DevcheckError } from '../errors';

export interface Proc {
  pid: number;
  stop(): Promise<void>;
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
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return {
    pid,
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
    stdio: ['ignore', 'pipe', 'pipe'],
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

// Vite dev over the worktree's app, in http mode against the local Cognito stand-in, proxying the edge paths
// to the local server (app/vite.config.ts → APERTURE_LOCAL_EDGE). Ready once it serves the shell.
export async function startVite(o: {
  worktree: string;
  track: (p: Proc) => void;
  port: number;
  edgePort: number;
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
      env: { ...process.env, ...o.env, APERTURE_LOCAL_EDGE: `http://127.0.0.1:${o.edgePort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log = createWriteStream(o.logPath);
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const proc = asProc(child, 'vite');
  o.track(proc);
  const origin = `http://127.0.0.1:${o.port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw fail(`vite exited (${child.exitCode ?? child.signalCode}) — see ${o.logPath}`);
    try {
      const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return proc;
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
