// The Mac repo path, the one identifier never tracked (docs/ops/IDENTIFIERS.md): one line in the main checkout's
// gitignored `.local/mac-root`, written on the Mac (`pwd -P > .local/mac-root`), so every worktree reads the same
// file. Missing or malformed → the placeholder, and callers that print a hand-off line add MAC_ROOT_NOTE. Plain
// node, node: imports only (the bot CLI and the tower load this).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAC_PLACEHOLDER = '<mac-repo>';
export const MAC_ROOT_NOTE = `(${MAC_PLACEHOLDER} is the Mac repo path; this checkout has no valid .local/mac-root — write it once on the Mac: cd <the repo> && mkdir -p .local && pwd -P > .local/mac-root)`;
// An absolute path that is safe unquoted in a `cd …` line: no spaces, no shell metacharacters, no `..`.
const VALID = /^\/[\w./-]+$/;

export function macRootFile(): string | null {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return join(dirname(common), '.local', 'mac-root');
  } catch {
    return null;
  }
}

export function readMacRoot(file = macRootFile()): string | null {
  if (!file) return null;
  try {
    const v = readFileSync(file, 'utf8').trim().replace(/\/+$/, '');
    return VALID.test(v) && !v.split('/').includes('..') ? v : null;
  } catch {
    return null;
  }
}

export const macRoot = (file?: string | null): string =>
  readMacRoot(file === undefined ? macRootFile() : file) ?? MAC_PLACEHOLDER;
