// No personal identifier in any tracked file but identifiers.json (docs/ops/IDENTIFIERS.md): the maintainer's name,
// the personal mailbox, a concrete Mac home path, the Mac's projects folder, the dev account id. A failure lists
// `path:line kind`, never the identifier — that list is the worklist. The pinned literals the Mac-installed shell
// can't read from the config must still equal it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDENTIFIERS_FILE,
  IDS,
  SIM_RUNNER,
  SIM_RUNNERS,
  describeHits,
  findIdentifiers,
  identifierRules,
  projectsFolder,
  simCognitoPin,
} from './identifiers.ts';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const rules = identifierRules();

function scanTree(root: string): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const out: string[] = [];
  for (const f of files) {
    const named = findIdentifiers(f, rules); // a file named for someone is a hit too
    if (named.length) out.push(named.map((h) => `${f} (its path) ${h.kind}`).join('\n'));
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, f));
    } catch {
      continue; // deleted in the working tree, not yet staged
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const hits = findIdentifiers(buf.toString('utf8'), rules, f);
    if (hits.length) out.push(describeHits(hits, f));
  }
  return out;
}

describe('tracked files carry no personal identifier', () => {
  // Reading every tracked file is I/O over the container's host mount (virtiofs): ~1.5 s idle, 2–4 s under load,
  // which ran past vitest's 5 s default three times on 11-18 (F292). The rule checks are ~0.1 s of it.
  it('only identifiers.json and the sim runner pin hold one', { timeout: 30_000 }, () => {
    expect(scanTree(ROOT)).toEqual([]);
  });

  it('a seeded hit in a throwaway tree fails, its path too, and the config itself is exempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ids-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const word = IDS.maintainer.name.split(' ')[0]!;
    writeFileSync(join(dir, 'a.md'), `fine\nasked by ${word}\n`);
    writeFileSync(join(dir, 'b.ts'), `const p = '${['', 'Users', 'someone', 'x'].join('/')}';\n`);
    writeFileSync(join(dir, `${word.toLowerCase()}.md`), 'fine\n');
    writeFileSync(join(dir, IDENTIFIERS_FILE), JSON.stringify(IDS));
    execFileSync('git', ['add', '.'], { cwd: dir });
    expect(scanTree(dir).sort()).toEqual(
      ['a.md:2 name', 'b.ts:1 home-path', `${word.toLowerCase()}.md (its path) name`].sort(),
    );
  });
});

describe('rules', () => {
  const kinds = (s: string) => findIdentifiers(s, rules).map((h) => h.kind);

  // findIdentifiers skips the per-line pass for rules that miss the whole text; that must find exactly what checking
  // every line finds, whatever the neighbouring lines hold.
  it('the whole-text prefilter finds what a per-line scan finds', () => {
    const [first] = IDS.maintainer.name.split(' ') as [string];
    const id = IDS.aws.devAccountId;
    const home = ['', 'Users', 'someone', 'x'].join('/');
    const lines = [
      `asked by ${first}`,
      `${first.toLowerCase()}_todo`,
      `x${first}y`,
      `${IDS.email.contact.split('@')[0]}+a@gmail.com`,
      `cd ${home}`,
      '/Users/Shared',
      'x',
      `${id}`,
      `9${id}`,
      `${id}9`,
      id.slice(0, 4),
      id.slice(4),
      `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8)}`,
      simCognitoPin(),
      '',
      '\r',
      'plain text',
    ];
    const reference = (text: string, path: string) =>
      text
        .split('\n')
        .flatMap((l, i) => findIdentifiers(l, rules, path).map((h) => ({ ...h, line: i + 1 })));
    for (const path of ['', 'docs/a.md', SIM_RUNNER, IDENTIFIERS_FILE])
      for (const a of lines)
        for (const b of lines) {
          const text = `${a}\n${b}\n${a}${b}`;
          expect(findIdentifiers(text, rules, path), JSON.stringify([path, text])).toEqual(
            reference(text, path),
          );
        }
  });
  const [first, last] = IDS.maintainer.name.split(' ') as [string, string];
  const mailbox = IDS.email.contact.split('@')[0]!;

  it('blocks the name as a word, any case', () => {
    expect(kinds(`${first} said so`)).toEqual(['name']);
    expect(kinds(`${last.toUpperCase()}'s call`)).toEqual(['name']);
    expect(kinds(`owner: ${first.toLowerCase()}_todo`)).toEqual(['name']);
  });

  it('lets the domain, the GitHub login and the bundle prefix through', () => {
    expect(
      kinds(`https://${IDS.domains.dev} · ${IDS.repo} · ${IDS.bundlePrefix}.aperture.mailroom`),
    ).toEqual([]);
  });

  it('blocks every alias of the personal mailbox, but not a placeholder one', () => {
    expect(kinds(`${mailbox}+devcheck@gmail.com`)).toEqual(['personal-email']);
    expect(kinds('you@gmail.com')).toEqual([]);
    expect(kinds(IDS.email.devTestUser)).toEqual([]);
  });

  it('blocks a concrete home path, not placeholders', () => {
    const home = ['', 'Users', 'someone', 'repo'].join('/');
    expect(kinds(`cd ${home}`)).toEqual(['home-path']);
    for (const ok of [
      '/Users/<you>/repo',
      '/Users/$USER/x',
      '/Users/…/aperture',
      '/Users/Shared/x',
      '<mac-repo>/x',
    ])
      expect(kinds(ok), ok).toEqual([]);
  });

  const root = ['', 'Users', 'someone', 'Alpha', 'Beta', 'repo'].join('/');
  const folderKinds = (s: string, r: string | null = root) =>
    findIdentifiers(s, identifierRules(IDS, r)).map((h) => h.kind);

  it("blocks the projects folder's first name under a home prefix, alone", () => {
    for (const hit of [
      '~/Alpha/x',
      '$HOME/Alpha',
      '${HOME}/Alpha/a',
      '"~\\/Alpha\\/x"',
      '~/alpha ',
      '"$HOME"/Alpha/x',
      '${HOME:-/tmp}/Alpha',
      '~/Alpha/Beta/x', // the full form too: still one hit
    ])
      expect(folderKinds(hit), hit).toEqual(['projects-folder']);
    for (const ok of [
      '~/AlphaGuide',
      'docs/Alpha/x',
      '$HOMEX/Alpha',
      '/home/u/Alpha',
      '~/<other-project>',
    ])
      expect(folderKinds(ok), ok).toEqual([]);
  });

  it('builds the projects-folder rule from the Mac root, and has none without it', () => {
    expect(folderKinds('~/Alpha/Beta/x')).toEqual(['projects-folder']);
    expect(folderKinds('alpha\\beta')).toEqual(['projects-folder']);
    expect(folderKinds('Beta/x')).toEqual([]);
    expect(projectsFolder(root)).toEqual(['Alpha', 'Beta']);
    for (const none of [null, ['', 'Users', 'someone', 'repo'].join('/'), '/Volumes/host/aperture'])
      expect(projectsFolder(none), String(none)).toBeNull();
    expect(identifierRules(IDS, null).map(([k]) => k)).not.toContain('projects-folder');
    expect(folderKinds('~/Alpha/x', null)).toEqual([]);
  });

  it('blocks the dev account id on digit boundaries only', () => {
    const id = IDS.aws.devAccountId;
    expect(kinds(`aperture-dev-${id}.auth`)).toEqual(['account-id']);
    expect(kinds(`9${id}`)).toEqual([]);
  });

  it('allows the sim runner pin only on its own line, only for the account id', () => {
    const pin = simCognitoPin();
    expect(findIdentifiers(pin, rules, SIM_RUNNER)).toEqual([]);
    expect(findIdentifiers(`# ${pin}`, rules, SIM_RUNNER).map((h) => h.kind)).toEqual([
      'account-id',
    ]);
    expect(findIdentifiers(pin, rules, 'tools/other.sh').map((h) => h.kind)).toEqual([
      'account-id',
    ]);
  });
});

// The Mac-installed shell can't read identifiers.json (launchd runs copies fetched from GitHub;
// the installed runner is the trust boundary), so each keeps one literal, held equal to the config here.
describe('pinned literals equal the config', () => {
  const text = (f: string) => readFileSync(join(ROOT, f), 'utf8');
  const pins: Array<[string, string]> = [
    ...SIM_RUNNERS.flatMap((f): Array<[string, string]> => [
      [f, simCognitoPin()],
      [f, `SIM_EMAIL="${IDS.email.devTestUser}"`],
    ]),
    ['tools/mailroom/bench/sim-bench.sh', `EMAIL="${IDS.email.devTestUser}"`],
    ['tools/mailroom/bench/sim-bench.sh', `ORIGIN="https://${IDS.domains.dev}"`],
    ['tools/mailroom/bench/sim-bench.sh', `LABEL="${IDS.bundlePrefix}.aperture.mailroom"`],
    ['tools/mailroom/install.sh', `LABEL="${IDS.bundlePrefix}.aperture.mailroom"`],
    ['tools/mailroom/install.sh', `LABEL_FAST="${IDS.bundlePrefix}.aperture.mailroom.fast"`],
    ['tools/mailroom/install.sh', `REPO_SLUG="${IDS.repo}"`],
    ['tools/mailroom/jobs/open-pr.sh', `MR_OWNER="${IDS.maintainer.github}"`],
    ['tools/mailroom/jobs/open-pr.sh', `MR_REPO="${IDS.repo}"`],
    // job.ts builds the same cross-reference rule from the config; the Mac mirror keeps it literal
    [
      'tools/mailroom/jobs/open-pr.sh',
      `MR_XREF='[Gg][Ii][Tt][Hh][Uu][Bb]\\.[Cc][Oo][Mm]/(?!${IDS.repo.replace(/[.]/g, '\\.')}/)`,
    ],
    ['tools/macstats/install.sh', `LABEL="${IDS.bundlePrefix}.aperture.macstats"`],
    ['tools/macstats/install.sh', `REPO_SLUG="${IDS.repo}"`],
    [
      'tools/raycast/aperture-add.sh',
      `APERTURE_URL="\${APERTURE_URL:-https://${IDS.domains.prod}}"`,
    ],
  ];
  it('every Mac-installed literal equals identifiers.json', () => {
    expect(
      pins.filter(
        ([f, pin]) =>
          !text(f)
            .split('\n')
            .some((l) => l.startsWith(pin)),
      ),
    ).toEqual([]);
  });
});
