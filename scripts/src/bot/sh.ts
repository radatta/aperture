// Child processes for the bot: argv arrays only (no shell), stdout trimmed, both streams in the error. Secrets travel
// in `env`, never in argv — COI and `ps` see every argv.
import { execFileSync } from 'node:child_process';

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number; // SIGTERM past it: git removes its lock files on TERM
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 << 20, // a big commit's diff (a lockfile, a regenerated fixture) passes 1 MiB
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      killSignal: 'SIGTERM',
    }).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT')
      throw new Error(`${cmd} ${args[0] ?? ''} timed out after ${(opts.timeoutMs ?? 0) / 1000} s`, {
        cause: err,
      });
    // stdout too: `git push --porcelain` prints a rejected ref's reason there, not on stderr.
    const e = err as { stdout?: string; stderr?: string; message: string };
    const out = [e.stdout?.trim(), (e.stderr || e.message).trim()].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${out}`, {
      cause: err,
    });
  }
}

export type Run = typeof run;
