// Child processes for the bot: argv arrays only (no shell), stdout trimmed, stderr in the error. Secrets travel
// in `env`, never in argv — COI and `ps` see every argv.
import { execFileSync } from 'node:child_process';

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(e.stderr || e.message).trim()}`, {
      cause: err,
    });
  }
}

export type Run = typeof run;
