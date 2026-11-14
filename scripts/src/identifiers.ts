// The repo's public identifiers — `identifiers.json` at the root, their one tracked home (docs/ops/IDENTIFIERS.md) —
// and the one rule set that keeps the personal ones out of everything else: tracked files
// (tracked-identifiers.test.ts), commits (.claude/hooks/precommit-guard.sh, via identifiers-scan.ts) and PR titles
// and bodies (mailroom/open-pr.ts). Every pattern is built from the config or the gitignored .local/mac-root, so no
// rule spells an identifier itself.
// Read at runtime, never imported: the file sits outside every package's rootDir. Imports stay node: only, so the
// bot CLI and the hook still load this under plain node.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macRootFile, readMacRoot } from './mac-root.ts';

export interface Identifiers {
  maintainer: { name: string; github: string };
  repo: string;
  email: { contact: string; alerts: string; devTestUser: string };
  domains: { apex: string; prod: string; dev: string; devb: string };
  aws: { devAccountId: string; region: string; prodAccountSha256: string };
  bundlePrefix: string;
}

export const IDENTIFIERS_FILE = 'identifiers.json';
export const IDENTIFIERS_PATH = fileURLToPath(
  new URL(`../../${IDENTIFIERS_FILE}`, import.meta.url),
);

export function loadIdentifiers(path = IDENTIFIERS_PATH): Identifiers {
  const ids = JSON.parse(readFileSync(path, 'utf8')) as Identifiers;
  if (
    !ids.maintainer?.name ||
    !ids.repo ||
    !/^\d{12}$/.test(ids.aws?.devAccountId ?? '') ||
    !/^[0-9a-f]{64}$/.test(ids.aws?.prodAccountSha256 ?? '')
  )
    throw new Error(
      `${path}: maintainer.name, repo, a 12-digit aws.devAccountId and aws.prodAccountSha256 are required`,
    );
  return ids;
}

export const IDS = loadIdentifiers();
export const REPO_SLUG = IDS.repo;
// The dev slot's Cognito Hosted UI host: CDK names the domain prefix aperture-<stage>-<account> (data-stack.ts).
export const cognitoHost = (slot: 'dev' | 'devb', ids = IDS): string =>
  `aperture-${slot}-${ids.aws.devAccountId}.auth.${ids.aws.region}.amazoncognito.com`;

// What may never appear outside the config: the maintainer's name, the personal mailbox, a concrete Mac home path,
// the Mac's projects folder (derived from .local/mac-root; no rule without it), and the AWS account ids (public-prep's scan, 2026-11-13): dev's by its id, prod's by its
// id's sha256, since the prod id is in no tracked file at all — not even the config.
export type IdentifierKind =
  'name' | 'personal-email' | 'home-path' | 'projects-folder' | 'account-id' | 'prod-account-id';
export type IdentifierRule = [IdentifierKind, (line: string) => boolean];
export interface IdentifierHit {
  kind: IdentifierKind;
  line: number; // 1-based
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PERSONAL_MAIL = /@(gmail|googlemail)\.com$/i;
// An account id as written plain or in the console's dashed form (1234-5678-9012), on digit boundaries.
const ACCOUNT_IDS = /(?<!\d)\d{4}-?\d{4}-?\d{4}(?!\d)/g;
const accountIds = (l: string) => [...l.matchAll(ACCOUNT_IDS)].map((m) => m[0].replaceAll('-', ''));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const test = (re: RegExp) => (l: string) => re.test(l);
const SEP = '\\\\?[/\\\\]'; // a slash, JSON-escaped or not, or a backslash
// ~, $HOME or ${HOME} (a :- default too), quoted or not.
const HOME = '(?:~|\\$HOME|\\$\\{HOME(?::-[^}]*)?\\})"?';

// '/Users/<name>/<a>/<b>/<repo>' → ['<a>', '<b>']: the folders between the home and the repo. Fewer than two, or a
// root outside /Users → null: one generic word would match everywhere.
export function projectsFolder(root: string | null): string[] | null {
  const segs = root?.split('/') ?? [];
  if (segs[0] !== '' || segs[1] !== 'Users') return null;
  const folder = segs.slice(3, -1).filter(Boolean);
  return folder.length >= 2 ? folder : null;
}

// Read once per process: findIdentifiers() builds the rules per call, and the tower calls it in a loop.
let localRoot: string | null | undefined;
const localMacRoot = (): string | null =>
  localRoot === undefined
    ? (localRoot = readMacRoot(macRootFile(dirname(fileURLToPath(import.meta.url)))))
    : localRoot;

export function identifierRules(ids = IDS, root: string | null = localMacRoot()): IdentifierRule[] {
  // Whole words only, so the domain (the name run together) and the GitHub login don't match.
  const words = ids.maintainer.name.split(/\s+/).filter((w) => w.length >= 3);
  // A personal mailbox's local part, before any +alias: blocks every alias of it, not just one address.
  const locals = [...new Set(Object.values(ids.email).filter((e) => PERSONAL_MAIL.test(e)))].map(
    (e) => e.split('@')[0]!.split('+')[0]!,
  );
  const rules: IdentifierRule[] = [];
  if (words.length)
    rules.push([
      'name',
      test(new RegExp(`(?<![A-Za-z0-9])(${words.map(escape).join('|')})(?![A-Za-z0-9])`, 'i')),
    ]);
  if (locals.length)
    rules.push(['personal-email', test(new RegExp(locals.map(escape).join('|'), 'i'))]);
  // Case-sensitive: an API's /users/me is no Mac home. JSON's escaped slashes count too.
  rules.push(['home-path', test(/\\?\/Users\\?\/(?!Shared(?![\w.-]))[A-Za-z0-9_][\w.-]*/)]);
  // Only where the Mac root is known (the container's hook, bot push, open-pr): CI and a fresh clone have no rule. The
  // whole folder counts anywhere; its first folder alone under a home prefix (~, $HOME, ${HOME}). One rule, so a line
  // holding both hits once.
  const folder = projectsFolder(root);
  if (folder) {
    const whole = new RegExp(folder.map(escape).join(SEP), 'i');
    const underHome = new RegExp(`${HOME}${SEP}${escape(folder[0]!)}\\b`, 'i');
    rules.push(['projects-folder', (l) => whole.test(l) || underHome.test(l)]);
  }
  rules.push(
    ['account-id', (l) => accountIds(l).includes(ids.aws.devAccountId)],
    [
      'prod-account-id',
      (l) => accountIds(l).some((id) => sha256(id) === ids.aws.prodAccountSha256),
    ],
  );
  return rules;
}

// The exceptions, by tracked path: the config itself, and the installed sim runner's pinned Cognito host — it checks
// the sim's address bar against that pin before typing the test password, so the pin can't come from a file the
// container can write; tracked-identifiers.test.ts holds it equal to the config. The bench keeps a copy beside its
// fake runner (runner.sh sources jobs/ beside itself), pinned the same.
export const SIM_RUNNER = 'tools/mailroom/jobs/sim.sh';
export const SIM_RUNNERS = [SIM_RUNNER, 'tools/mailroom/bench/fixtures/jobs/sim.sh'];
export const simCognitoPin = (ids = IDS): string =>
  `SIM_COGNITO_RE='^${escape(cognitoHost('dev', ids))}$'`;
export function allowed(path: string, kind: IdentifierKind, line: string, ids = IDS): boolean {
  if (path === IDENTIFIERS_FILE) return true;
  return SIM_RUNNERS.includes(path) && kind === 'account-id' && line === simCognitoPin(ids);
}

export function findIdentifiers(
  text: string,
  rules = identifierRules(),
  path = '',
): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  text.split('\n').forEach((l, i) => {
    for (const [kind, hit] of rules)
      if (hit(l) && !(path && allowed(path, kind, l))) hits.push({ kind, line: i + 1 });
  });
  return hits;
}

export const describeHits = (hits: IdentifierHit[], where: string): string =>
  hits.map((h) => `${where}:${h.line} ${h.kind}`).join('\n');
