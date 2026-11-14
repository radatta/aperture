// The identifier check on what's about to leave the container (docs/ops/IDENTIFIERS.md). As a CLI it is the commit
// hook's (.claude/hooks/precommit-guard.sh): stdin is a unified diff (`-U0`, a/ b/ prefixes, core.quotePath=false),
// HOOK_CMD the commit command, whose -m messages are checked too. Prints one `<where>:<line> <kind>` per hit — never
// the identifier itself — and exits 1 on any, 0 when clean, 2 when the scan itself failed (the hook fails open).
// Only added lines and new paths count, so a commit that removes an identifier passes. `pnpm bot push` runs
// scanRange over every commit it's about to publish. Plain node, node: imports only.
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeHits, findIdentifiers, identifierRules } from './identifiers.ts';

// A header path: `b/<path>`, `"b/<quoted>"` (C-style escapes, when core.quotePath is on), and git's trailing tab
// after a name with a space.
function headerPath(raw: string): string {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"'))
    p = Buffer.from(
      p
        .slice(1, -1)
        .replace(/\\([0-7]{3}|.)/g, (_, e: string) =>
          /^[0-7]{3}$/.test(e)
            ? String.fromCharCode(parseInt(e, 8))
            : e === 't'
              ? '\t'
              : e === 'n'
                ? '\n'
                : e,
        ),
      'latin1',
    ).toString('utf8');
  return p === '/dev/null' ? '' : p.replace(/^b\//, '');
}

// The `b/` side of a `diff --git a/… b/…` line: the last quoted token, else what follows the last ` b/`.
function gitLinePath(l: string): string {
  const q = /("(?:[^"\\]|\\.)*")$/.exec(l);
  if (q) return headerPath(q[1]!);
  // Unquoted, both sides are the same path when it isn't a rename (renames carry `rename to`): split at the middle,
  // so a name that itself holds ` b/` isn't cut short.
  const rest = l.slice('diff --git '.length);
  const n = (rest.length - 1) / 2;
  if (Number.isInteger(n) && rest.slice(0, n) === `a/${rest.slice(n + 3)}`)
    return rest.slice(n + 3);
  const i = rest.lastIndexOf(' b/');
  return i < 0 ? '' : rest.slice(i + 3);
}

export function scanDiff(diff: string, rules = identifierRules()): string[] {
  const out: string[] = [];
  let path = '';
  let line = 0;
  // Between `diff --git` and the first @@ (or the next file): only there is `+++ ` a header. A rename, a binary or
  // an empty new file has no `+++`, so its name comes from the `diff --git` line (or `rename to`/`copy to`); a
  // deleted file's name doesn't count — removing it is the fix.
  let header: { b: string; plus: string | null; deleted: boolean } | null = null;
  const endHeader = () => {
    if (!header) return;
    path = header.plus ?? (header.deleted ? '' : header.b);
    const named = path ? findIdentifiers(path, rules) : [];
    if (named.length) out.push(named.map((h) => `${path} (its path) ${h.kind}`).join('\n'));
    header = null;
  };
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      endHeader();
      header = { b: gitLinePath(l), plus: null, deleted: false };
      path = '';
      continue;
    }
    if (header) {
      if (l.startsWith('+++ ')) header.plus = headerPath(l.slice(4));
      else if (l.startsWith('deleted file mode')) header.deleted = true;
      else if (/^(rename|copy) to /.test(l))
        header.b = headerPath(l.replace(/^(rename|copy) to /, ''));
      if (!l.startsWith('@@')) continue;
      endHeader();
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (path && l.startsWith('+')) {
      const hits = findIdentifiers(l.slice(1), rules, path).map((h) => ({ ...h, line }));
      if (hits.length) out.push(describeHits(hits, path));
      line++;
    }
  }
  endHeader();
  return out;
}

// The -m / --message values of a commit command, as the shell would see them (single or double quotes, or a bare
// word). Only the message is scanned, not the whole line: `git rm <a file named for someone> && git commit` removes.
export function commitMessages(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s+)?("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"';&|]+)/g;
  for (const m of command.matchAll(re)) {
    const v = m[1]!;
    out.push(
      v.startsWith('"')
        ? v.slice(1, -1).replace(/\\(.)/g, '$1')
        : v.startsWith("'")
          ? v.slice(1, -1)
          : v,
    );
  }
  return out;
}

export function scanCommit(diff: string, command: string, rules = identifierRules()): string[] {
  const msg = findIdentifiers(commitMessages(command).join('\n'), rules);
  return [
    ...(msg.length ? [describeHits(msg, 'the commit message')] : []),
    ...scanDiff(diff, rules),
  ];
}

// Every commit in a range, as `pnpm bot push` publishes them: each message and each commit's own diff (an
// identifier added in one commit and removed in the next is still in the pushed history).
export function scanRange(
  commits: { sha: string; message: string; diff: string }[],
  rules = identifierRules(),
): string[] {
  return commits.flatMap(({ sha, message, diff }) => {
    const msg = findIdentifiers(message, rules);
    return [
      ...(msg.length ? [describeHits(msg, `${sha.slice(0, 12)} message`)] : []),
      ...scanDiff(diff, rules).map((h) => `${sha.slice(0, 12)} ${h}`),
    ];
  });
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

if (isMain()) {
  try {
    const found = scanCommit(readFileSync(0, 'utf8'), process.env.HOOK_CMD ?? '');
    if (found.length) {
      console.log(found.join('\n'));
      process.exit(1);
    }
  } catch (err) {
    console.error(`identifiers-scan: ${(err as Error).message}`);
    process.exit(2);
  }
}
