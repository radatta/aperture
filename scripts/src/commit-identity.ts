// The commit-identity check (docs/ops/IDENTIFIERS.md → _The checks_ → Commit identity): every commit that leaves the container is
// authored and committed as the maintainer's GitHub login with a GitHub noreply address — never a name or mailbox a
// global git config or an override supplied. Built from identifiers.json's `maintainer.github`, no new key. Three
// callers: the commit hook (.claude/hooks/precommit-guard.sh, this file as a CLI), `pnpm bot push` and
// `pnpm mailroom open-pr` (rangeIdentityHits). Hits name the commit, the role and the field — never the value, since
// a wrong one is likely the personal mailbox. Plain node, node: imports and ./identifiers.ts only.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IDS } from './identifiers.ts';
import type { Identifiers } from './identifiers.ts';

export interface Identity {
  name: string;
  email: RegExp;
}
type Field = 'name' | 'email';
type Run = (cmd: string, args: string[]) => string;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GitHub's noreply address for the login, with or without its numeric id (`<id>+<login>@…`, `<login>@…`). A missing
// or malformed login throws here, so only this check stops (the hook's CLI exits 2 and fails open); identifiers.ts
// loads without it, so the identifier scan still runs.
export function expectedIdentity(ids: Pick<Identifiers, 'maintainer'> = IDS): Identity {
  const login: unknown = ids.maintainer.github;
  if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login))
    throw new Error(
      'identifiers.json: maintainer.github must be a GitHub login (letters, digits, hyphens; 1–39)',
    );
  return {
    name: login,
    email: new RegExp(`^(\\d+\\+)?${escape(login)}@users\\.noreply\\.github\\.com$`, 'i'),
  };
}

// The fields that are wrong, in order; empty when the identity is the expected one.
export function identityProblem(name: string, email: string, want = expectedIdentity()): Field[] {
  const bad: Field[] = [];
  if (name !== want.name) bad.push('name');
  if (!want.email.test(email)) bad.push('email');
  return bad;
}

// Every commit in a range (git rev-list arguments, e.g. ['origin/main..HEAD', '^<sha>']): author and committer.
export function rangeIdentityHits(run: Run, range: string[], want = expectedIdentity()): string[] {
  let log: string;
  try {
    // --no-show-signature: log.showSignature=true would add gpg lines to the output.
    log = run('git', [
      'log',
      '--no-show-signature',
      '--format=%H%x00%an%x00%ae%x00%cn%x00%ce',
      ...range,
    ]);
  } catch (err) {
    throw new Error("can't list the commits to check their identity — `git fetch origin` first", {
      cause: err,
    });
  }
  return log
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      const [sha = '', an = '', ae = '', cn = '', ce = ''] = l.split('\0');
      return [
        ...identityProblem(an, ae, want).map((f) => `${sha.slice(0, 12)} author ${f}`),
        ...identityProblem(cn, ce, want).map((f) => `${sha.slice(0, 12)} committer ${f}`),
      ];
    });
}

// The fix, for every refusal: the expected identity in this checkout's config, no override, then the branch restamped
// (a rebase keeps each author, so the exec resets them; it replays a branch already on origin/main too).
export const IDENTITY_FIX = (login = IDS.maintainer.github): string =>
  `Set it — \`git config user.name ${login}\`, \`git config user.email ${login}@users.noreply.github.com\` (or its \`<id>+\` form) — drop any override, then restamp the branch: \`git rebase origin/main --exec 'git commit --amend --no-edit --reset-author'\` and \`pnpm bot push --after-rebase\``;

// The command as shell words: quotes and backslashes resolved, `;`, `&`, `|`, `(`, `)` and a newline as words of
// their own (a separator run, e.g. `&&`, is one word). Null — the caller then matches the raw line, failing closed —
// on an unterminated quote, any `<<` (a heredoc body isn't words: an apostrophe in it would open a quote that hides
// what follows) or an unquoted word starting with `#` (a comment, the same). `$(…)` is read as plain words.
export function shellWords(command: string): string[] | null {
  if (command.includes('<<')) return null;
  const words: string[] = [];
  let w = '';
  let open = false; // a word is being read (an empty quoted word counts)
  let quote = '';
  const add = (s: string) => {
    w += s;
    open = true;
  };
  const end = () => {
    if (open) words.push(w);
    w = '';
    open = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1] ?? '';
    if (quote === "'") {
      if (c === "'") quote = '';
      else add(c);
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && next && '"\\$`'.includes(next)) add(command[++i]!);
      else if (c === '\\' && next === '\n') i++;
      else add(c);
    } else if (c === "'" || c === '"') {
      quote = c;
      add('');
    } else if (c === '\\') {
      i++;
      if (next && next !== '\n') add(next);
    } else if (c === '#' && !open) return null;
    else if (c === ' ' || c === '\t') end();
    else if (';&|()\n'.includes(c)) {
      end();
      const prev = words.at(-1) ?? '';
      // A run of separators (`&&`, `||`, `;;`) is one word; a newline reads as `;`.
      if (c !== '\n' && /^[;&|()]+$/.test(prev) && command[i - 1] === prev.at(-1))
        words[words.length - 1] = prev + c;
      else words.push(c === '\n' ? ';' : c);
    } else add(c);
  }
  if (quote) return null;
  end();
  return words;
}

// The words minus every commit message and message file — `-m`, `--message` (`--m` and up: git takes a unique
// prefix), `-F`, `--file` (`--fil` and up), glued, `=`-joined or in a short cluster like `-am` (not after `-u`, which
// takes the rest of its word as its own value) — so a message that
// mentions `--author` or GIT_AUTHOR_EMAIL= is text, not an override. Anywhere in the line: a `git tag -m` message
// is text too.
const MSG_LONG = /^--(m(?:e(?:s(?:s(?:a(?:g(?:e)?)?)?)?)?)?|fil(?:e)?)(=.*)?$/;
const MSG_SHORT = /^-[apqsnvzeio]*[mF](.*)$/;
export function withoutMessages(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const long = MSG_LONG.exec(words[i]!);
    const short = long ? null : MSG_SHORT.exec(words[i]!);
    // The value is the next word, unless glued on or the next word is a separator (`-m;` gives git no message).
    const takesNext = long ? long[2] === undefined : short ? !short[1] : false;
    if (!long && !short) out.push(words[i]!);
    else if (takesNext && !/^[;&|()]+$/.test(words[i + 1] ?? ';')) i++;
  }
  return out;
}

// What a commit command overrides that `git var` can't see before it runs, matched on the command without its
// messages: a GIT_AUTHOR_*/GIT_COMMITTER_* name or email set (`=` or `+=`) in it, `--author` (any prefix from `--au`,
// which git takes), `-c`/`--config-env` on an identity or include key, a `git config` of one, and — failing closed,
// whatever they hold — a GIT_CONFIG_KEY_<n>, GIT_CONFIG_PARAMETERS, GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM, or a
// HOME, XDG_CONFIG_HOME, GIT_DIR or GIT_COMMON_DIR (git pointed at other config) or EMAIL (git's identity fallback:
// with no user.email it makes `git var` exit 128 — the hook fails open — and git commits as it) set in it. Names the
// shape, never the value.
const KEY = '(?:(?:user|author|committer)\\.(?:name|email)|include\\.path|includeif\\.)';
const OVERRIDES: [string, RegExp][] = [
  [
    'a GIT_AUTHOR_/GIT_COMMITTER_ name or email set in the command',
    /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)\+?=/,
  ],
  [
    'git config set through GIT_CONFIG_* in the command',
    /\bGIT_CONFIG_(?:KEY_\d+|PARAMETERS|GLOBAL|SYSTEM)\+?=/,
  ],
  [
    'git pointed at other config or identity (HOME, XDG_CONFIG_HOME, GIT_DIR, GIT_COMMON_DIR or EMAIL set in the command)',
    /(?<![\w$])(?:HOME|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR|EMAIL)\+?=/,
  ],
  ['`--author` on the commit', /\bcommit\b[^;&|]*\s--au(?:t(?:h(?:o(?:r)?)?)?)?(?=[=\s]|$)/],
  ['`-c` on an identity or include key', new RegExp(`(?:^|\\s)-c\\s*['"]?${KEY}`, 'i')],
  [
    '`--config-env` on an identity or include key',
    new RegExp(`--config-env[=\\s]+['"]?${KEY}`, 'i'),
  ],
  [
    '`git config` of an identity or include key in the same command',
    new RegExp(`\\bgit\\b(?:\\s+(?:-[Cc]\\s+\\S+|-\\S+))*\\s+config\\b[^;&|]*\\b${KEY}`, 'i'),
  ],
];
// The command as matched: its words without messages, rejoined; the raw command when it can't be split (fail closed).
const matchable = (command: string): string => {
  const words = shellWords(command);
  return words ? withoutMessages(words).join(' ') : command;
};
export const overrideProblems = (command: string): string[] => {
  const text = matchable(command);
  return OVERRIDES.filter(([, re]) => re.test(text)).map(([what]) => what);
};

// `--amend` (from `--am`) keeps HEAD's author unless the last `--reset-author`/`--no-reset-author` (from `--res`,
// `--no-res`) of the same simple command is a reset — a reset in a later command (a rebase's --exec) doesn't count
// for an earlier amend. Split at separators, a quoted --exec body's included.
const AMEND = /\bcommit\b.*\s--am(?:e(?:n(?:d)?)?)?(?=\s|$)/;
const RESET = /(?:^|\s)--(no-)?res(?:e(?:t(?:-(?:a(?:u(?:t(?:h(?:o(?:r)?)?)?)?)?)?)?)?)?(?=\s|$)/g;
export const keepsHeadAuthor = (command: string): boolean =>
  matchable(command)
    .split(/[;&|()\n]/)
    .some((cmd) => {
      const last = [...cmd.matchAll(RESET)].at(-1);
      return AMEND.test(cmd) && (!last || last[1] !== undefined);
    });

// The hook's input: `author <ident>`, `committer <ident>` (git var GIT_AUTHOR_IDENT / GIT_COMMITTER_IDENT) and
// `head-author <ident>` (HEAD's %an <%ae>, absent on an unborn branch), one per line. Null when author or committer
// is missing: the hook can't tell, so it fails open.
export function commandHits(
  idents: string,
  command: string,
  want = expectedIdentity(),
): string[] | null {
  const seen = new Map<string, [string, string]>();
  for (const l of idents.split('\n')) {
    const m = /^(author|committer|head-author) (.*?) ?<([^>]*)>/.exec(l);
    if (m) seen.set(m[1]!, [m[2]!, m[3]!]);
  }
  const author = seen.get('author');
  const committer = seen.get('committer');
  if (!author || !committer) return null;
  const head = keepsHeadAuthor(command) ? seen.get('head-author') : undefined;
  return [
    ...overrideProblems(command),
    ...identityProblem(...author, want).map((f) => `the author ${f}`),
    ...identityProblem(...committer, want).map((f) => `the committer ${f}`),
    ...(head
      ? identityProblem(...head, want).map((f) => `HEAD's author ${f} (kept by --amend)`)
      : []),
  ];
}

// realpath both sides: a checkout reached through a symlink would otherwise never match and the hook would pass.
const isMain = () => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
};

// The hook's CLI: exit 1 with one hit per line, 0 when clean, 2 when it can't tell (the hook fails open).
if (isMain()) {
  try {
    const hits = commandHits(readFileSync(0, 'utf8'), process.env.HOOK_CMD ?? '');
    if (hits === null) throw new Error('no author or committer ident on stdin');
    if (hits.length) {
      console.log(hits.join('\n'));
      process.exit(1);
    }
  } catch (err) {
    console.error(`commit-identity: ${(err as Error).message}`);
    process.exit(2);
  }
}
