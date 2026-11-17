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

// GitHub's noreply address for the login, with or without its numeric id (`<id>+<login>@…`, `<login>@…`).
export const expectedIdentity = (ids: Pick<Identifiers, 'maintainer'> = IDS): Identity => ({
  name: ids.maintainer.github,
  email: new RegExp(
    `^(\\d+\\+)?${escape(ids.maintainer.github)}@users\\.noreply\\.github\\.com$`,
    'i',
  ),
});

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
    log = run('git', ['log', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', ...range]);
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

// What a commit command overrides that `git var` can't see before it runs: an inline or exported
// GIT_AUTHOR_*/GIT_COMMITTER_* name or email, `--author`, `-c`/`--config-env` on an identity key, and a
// `git config` of one in the same line. Names the shape, never the value.
const KEY = '(?:user|author|committer)\\.(?:name|email)';
const OVERRIDES: [string, RegExp][] = [
  [
    'a GIT_AUTHOR_/GIT_COMMITTER_ name or email set in the command',
    /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)=/,
  ],
  ['`--author` on the commit', /\bcommit\b[^;&|\n]*\s--author\b/],
  ['`-c` on an identity key', new RegExp(`(?:^|\\s)-c\\s*${KEY}\\b`, 'i')],
  ['`--config-env` on an identity key', new RegExp(`--config-env[=\\s]+${KEY}\\b`, 'i')],
  [
    '`git config` of an identity key in the same command',
    new RegExp(`\\bgit\\b(?:\\s+-[Cc]\\s+\\S+)*\\s+config\\b[^;&|\\n]*\\b${KEY}\\b`, 'i'),
  ],
];
export const overrideProblems = (command: string): string[] =>
  OVERRIDES.filter(([, re]) => re.test(command)).map(([what]) => what);

// `--amend` keeps HEAD's author unless `--reset-author` replaces it.
export const keepsHeadAuthor = (command: string): boolean =>
  /\bcommit\b[^;&|\n]*\s--amend\b/.test(command) && !/\s--reset-author\b/.test(command);

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
