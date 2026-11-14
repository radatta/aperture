// The commit hook's identifier check (.claude/hooks/precommit-guard.sh): stdin is `git diff --cached -U0`, and
// HOOK_CMD the commit command (its message included). Prints one `<where>:<line> <kind>` per hit — never the
// identifier itself — and exits 1 on any, 0 when clean. Only added lines count, so a commit that removes an
// identifier passes. Plain node, node: imports only.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  describeHits,
  findIdentifiers,
  identifierRules,
  type IdentifierHit,
} from './identifiers.ts';

export function scanDiff(diff: string, rules = identifierRules()): string[] {
  const out: string[] = [];
  let path = '';
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      path = l.startsWith('+++ b/') ? l.slice(6) : '';
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path || l.startsWith('---')) continue;
    if (l.startsWith('+')) {
      const hits = findIdentifiers(l.slice(1), rules, path).map((h): IdentifierHit => ({
        ...h,
        line,
      }));
      if (hits.length) out.push(describeHits(hits, path));
      line++;
    }
  }
  return out;
}

export function scanCommit(diff: string, command: string, rules = identifierRules()): string[] {
  const cmd = findIdentifiers(command, rules);
  return [
    ...(cmd.length ? [describeHits(cmd, 'the commit command')] : []),
    ...scanDiff(diff, rules),
  ];
}

// pathToFileURL, not a template: a checkout path with a space would never match and the hook would pass silently.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = scanCommit(readFileSync(0, 'utf8'), process.env.HOOK_CMD ?? '');
  if (found.length) {
    console.log(found.join('\n'));
    process.exit(1);
  }
}
