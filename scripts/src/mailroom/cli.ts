// `pnpm mailroom <command>` — Claude's side of the Mac mailroom: the user's own Mac opens the PR (their PR-only
// token), so main's squash commits stay theirs. Not part of `pnpm bot`: the bot never opens PRs.
// Plain `node` (type stripping), builtins only, like bot/cli.ts. docs/ops/MAILROOM.md.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bot/cli.ts';
import type { Clock } from '../bot/dispatch.ts';
import { cliGuard, emit } from '../bot/help.ts';
import type { Spec } from '../bot/help.ts';
import { run } from '../bot/sh.ts';
import { clipProbe } from './clip.ts';
import { editPr } from './edit-pr.ts';
import { fixturesJob } from './fixtures-job.ts';
import { EXIT, openPr, probe } from './open-pr.ts';
import type { Deps } from './open-pr.ts';
import { simTrial } from './sim-trial.ts';
import { simCommand } from './sim.ts';
import { hostjobsDir, nodeFs, repoRunnerVersion } from './submit.ts';

export const USAGE = `pnpm mailroom <command>   (-h / --help on any command: its usage; nothing runs)
  open-pr --title "<title>" [--wait <seconds>]   open this pushed branch's PR as the user, from their Mac
  edit-pr [--title "<title>"] [--wait <seconds>] after a push: its open PR's body (and title) from localNotes/pr-<branch>.md
  fixtures [--sha <sha>]                         run a pushed commit's mailroom fixtures on the Mac, sandboxed (minutes)
  probe [--wait <seconds>]                       the whole path with a zero sha — stops before any write
  sim-probe [--sign-in]                          boot the Mac's iOS sim, launch the web app, screenshot (≤ 5 min)
  sim-shutdown                                   shut the Mac's iOS sim down
  clip-probe [--out <png>] [--wait <seconds>]    fetch the Mac clipboard's image, as tools/coi/xclip does on Ctrl+V
  sim-trial --tag <idle|loaded|…>                the input-gap trial: drops per keys/erase variant (~15 min)`;

// Every command's allowed flags; anything else refuses before it runs (bot/help.ts).
export const FLAGS: Record<string, Spec> = {
  'open-pr': { flags: ['title', 'wait'] },
  'edit-pr': { flags: ['title', 'wait'] },
  fixtures: { flags: ['sha'] },
  probe: { flags: ['wait'] },
  'sim-probe': { bare: ['sign-in'] },
  'sim-shutdown': {},
  'clip-probe': { flags: ['out', 'wait'] },
};

const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function main(argv: string[]): Promise<number> {
  const guard = cliGuard(argv, USAGE, FLAGS, parseArgs);
  if (guard) return emit(guard);
  const { positional, flags } = parseArgs(argv);
  const [cmd] = positional;
  const waitMs = flags.wait ? Number(flags.wait) * 1000 : undefined;
  if (waitMs !== undefined && !(waitMs > 0)) {
    console.error(`--wait wants seconds\n${USAGE}`);
    return EXIT.usage;
  }
  const root = () => run('git', ['rev-parse', '--show-toplevel']);
  const deps = (): Deps => ({
    run,
    fs: nodeFs,
    clock,
    dir: hostjobsDir(run),
    root: root(),
    repoVersion: () => repoRunnerVersion(root()),
    log: (s) => console.log(s),
  });
  switch (cmd) {
    case 'open-pr':
      if (!flags.title || flags.title === 'true') {
        console.error(`open-pr needs --title\n${USAGE}`);
        return EXIT.usage;
      }
      return openPr(deps(), flags.title, waitMs);
    case 'edit-pr':
      if (flags.title === 'true' || flags.title === '') {
        console.error(`--title needs a value (leave it out to keep the PR's title)\n${USAGE}`);
        return EXIT.usage;
      }
      return editPr(deps(), flags.title, waitMs);
    case 'probe':
      return probe(deps(), waitMs);
    case 'fixtures':
      if (flags.sha === 'true') {
        console.error(`--sha needs a value\n${USAGE}`);
        return EXIT.usage;
      }
      return fixturesJob(deps(), flags.sha);
    case 'sim-probe':
    case 'sim-shutdown':
      return simCommand(
        { fs: nodeFs, clock, dir: hostjobsDir(run), log: (s) => console.log(s) },
        cmd === 'sim-probe' ? 'probe' : 'shutdown',
        flags['sign-in'] === 'true',
      );
    case 'clip-probe':
      return clipProbe(
        {
          fs: nodeFs,
          clock,
          dir: hostjobsDir(run),
          out:
            flags.out && flags.out !== 'true' ? flags.out : `${root()}/localNotes/clip-probe.png`,
          log: (s) => console.log(s),
        },
        waitMs,
      );
    case 'sim-trial':
      return simTrial(
        { fs: nodeFs, clock, dir: hostjobsDir(run), log: (s) => console.log(s) },
        flags.tag ?? '',
      );
    case 'help':
    case undefined:
      console.log(USAGE);
      return cmd ? EXIT.ok : EXIT.usage;
    default:
      console.error(`unknown command "${cmd}"\n${USAGE}`);
      return EXIT.usage;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`mailroom: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
