// self-compact.sh (docs/ops/COMPACTION-HANDOFF.md → Self-compact) against a temp "main" repo with a lane worktree, a
// temp board, a recording tmux shim and a process named `claude`. The script reads no test-only env: the switch and
// the hub come from the temp main's committed files, tmux and sleep from PATH, the board from APERTURE_BOARD_DIR.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const boardSrc = fileURLToPath(new URL('../../board/', import.meta.url));
const children: ChildProcess[] = [];
vi.setConfig({ testTimeout: 20_000 }); // several bash + git cold starts; slower under a busy gate

const BRANCH = 'lane-x';
const PANE = '%7';
const AT = '2026-11-19T10:00:00Z';
const RULE = '─'.repeat(40);
const NBSP = String.fromCharCode(0xa0); // the box pads the prompt glyph with one
const screen = (box: string, { above = [] as string[], footer = ['  status line'] } = {}) =>
  [
    'earlier output',
    ...above,
    '',
    RULE,
    `❯${NBSP}${box}`,
    RULE,
    ...footer,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
const EMPTY = screen('');
const TYPED = screen('/compact');

let tmp: string, main: string, wt: string, board: string, shim: string, env: NodeJS.ProcessEnv;

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
function gitEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  return {
    ...e,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
const startOf = (pid: number) =>
  readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!;

// main's committed scripts/board: the script, lib.sh, the switch and the hub name.
function commitMain(selfCompact: unknown) {
  const sb = join(main, 'scripts/board');
  writeFileSync(join(sb, 'limits.json'), JSON.stringify({ v: 1, lanes: { selfCompact } }));
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'switch', '--allow-empty');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'self-compact-'));
  main = join(tmp, 'main');
  board = join(tmp, 'board');
  shim = join(tmp, 'shim');
  const sb = join(main, 'scripts/board');
  mkdirSync(sb, { recursive: true });
  for (const f of ['self-compact.sh', 'lib.sh']) copyFileSync(join(boardSrc, f), join(sb, f));
  writeFileSync(join(sb, 'hub.json'), JSON.stringify({ v: 1, name: 'dispatch' }));
  writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\n');
  git(tmp, 'init', '-q', '-b', 'main', main);
  commitMain(true);
  wt = join(main, '.claude/worktrees', BRANCH);
  git(main, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  mkdirSync(join(board, 'sessions'), { recursive: true });
  lane();
  mkdirSync(shim);
  // tmux: records every argv; capture-pane serves `screen`, or `screen-typed` once `-l` text was sent.
  writeFileSync(
    join(shim, 'tmux'),
    [
      '#!/bin/bash',
      'printf "%s|" "$@" >>"$SHIM/tmux.log"; echo >>"$SHIM/tmux.log"',
      'case "$1" in',
      '  display-message) cat "$SHIM/pane_pid" ;;',
      '  capture-pane) if [ -e "$SHIM/typed" ] && [ -e "$SHIM/screen-typed" ]; then cat "$SHIM/screen-typed"; else cat "$SHIM/screen"; fi ;;',
      '  send-keys) [ "${4:-}" = -l ] && touch "$SHIM/typed" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  writeFileSync(
    join(shim, 'sleep'),
    // sleep: instant unless SLOW_SLEEP; runs $SHIM/on-sleep-<arg> first, so a case can change state mid-send
    '#!/bin/bash\n[ -x "$SHIM/on-sleep-$1" ] && "$SHIM/on-sleep-$1"\n[ -n "${SLOW_SLEEP:-}" ] && exec /bin/sleep "$SLOW_SLEEP"\nexit 0\n',
  );
  chmodSync(join(shim, 'tmux'), 0o755);
  chmodSync(join(shim, 'sleep'), 0o755);
  screens(EMPTY, TYPED);
  env = {
    ...gitEnv(),
    PATH: `${shim}:${process.env.PATH}`,
    APERTURE_BOARD_DIR: board,
    TMUX_PANE: PANE,
    SHIM: shim,
    // no real tmux server is reachable: a send still running when afterEach removes the shim falls through PATH
    // to the real tmux, which must find no server (never this session's own pane %7)
    TMUX_TMPDIR: join(tmp, 'no-tmux'),
  };
  delete env.TMUX;
  delete env.APERTURE_HANDOFF_FORK;
  delete env.GIT_AUTHOR_NAME;
});
afterEach(() => {
  children.splice(0).forEach((c) => c.kill());
  rmSync(tmp, { recursive: true, force: true }); // a send still running finds no shim, main or tmux server
});

function lane(minutesOld = 0) {
  mkdirSync(join(board, 'lanes'), { recursive: true });
  const f = join(board, 'lanes', `${BRANCH}.json`);
  writeFileSync(f, JSON.stringify({ v: 1, branch: BRANCH, phase: 'review' }));
  if (minutesOld) {
    const t = Date.now() / 1000 - minutesOld * 60;
    utimesSync(f, t, t);
  }
}
function screens(before: string, typed?: string) {
  writeFileSync(join(shim, 'screen'), before);
  if (typed === undefined) rmSync(join(shim, 'screen-typed'), { force: true });
  else writeFileSync(join(shim, 'screen-typed'), typed);
}
function record(pid: number, patch: object = {}) {
  writeFileSync(
    join(board, 'sessions', `${pid}.json`),
    JSON.stringify({
      v: 1,
      pid,
      pidStart: startOf(pid),
      name: BRANCH,
      branch: BRANCH,
      cwd: wt,
      state: 'idle',
      lastPromptAt: AT,
      ...patch,
    }),
  );
}
const tmuxLog = () =>
  existsSync(join(shim, 'tmux.log')) ? readFileSync(join(shim, 'tmux.log'), 'utf8') : '';
const sends = () =>
  tmuxLog()
    .split('\n')
    .filter((l) => l.startsWith('send-keys|'));
const log = () =>
  existsSync(join(board, 'self-compact.log'))
    ? readFileSync(join(board, 'self-compact.log'), 'utf8')
    : '';
const flagDir = () => join(board, 'self-compact');

// `request` as the lane runs it: the script's parent's parent is a process whose comm is `claude` (a bash copy), so
// sb_claude_pid finds it. The wrapper waits for a line on stdin, so the test can write the record for its pid first.
// `pane: 'parent'` is the usual live shape: the pane's process is the shell that started claude.
async function request(
  opts: {
    record?: object | null;
    pane?: 'own' | 'parent' | 'other';
    cwd?: string;
    env?: object;
  } = {},
): Promise<{ code: number; out: string; pid: number; tick: string }> {
  const claude = claudeBin('claude-bin', '/bin/bash');
  const script = join(opts.cwd ?? wt, 'scripts/board/self-compact.sh');
  const c = spawn(claude, ['-c', 'read -r _; bash "$0" request; exit $?', script], {
    cwd: opts.cwd ?? wt,
    env: { ...env, ...opts.env },
  });
  children.push(c);
  let out = '';
  c.stdout!.on('data', (d) => (out += d));
  const pid = c.pid!;
  const tick = startOf(pid);
  if (opts.record !== null) record(pid, { state: 'working', ...opts.record });
  writeFileSync(join(shim, 'pane_pid'), String(panePid(opts.pane, pid)));
  c.stdin!.end('go\n');
  // close, not exit: stdout has drained by then
  const code = await new Promise<number>((r) => c.on('close', (n) => r(n ?? -1)));
  return { code, out, pid, tick };
}

// A binary named `claude`: a symlink, since comm is the exec'd name.
function claudeBin(dir: string, target: string) {
  const claude = join(tmp, dir, 'claude');
  if (!existsSync(claude)) {
    mkdirSync(join(tmp, dir), { recursive: true });
    symlinkSync(target, claude);
  }
  return claude;
}
// The claude processes here are children of this test's process, so its pid is their parent's.
const panePid = (pane: 'own' | 'parent' | 'other' | undefined, pid: number) =>
  pane === 'other' ? 1 : pane === 'parent' ? process.pid : pid;

// A live `claude` process for stop/send, with its board record and pane: bash blocked in its builtin `read` on a
// pipe this test never closes. Not a `sleep` symlink: a multicall coreutils (uutils, Ubuntu 25.10+) dispatches on the
// name, exits at once as `claude`, and leaves a zombie that reads as not alive.
function session(patch: object = {}, pane: 'own' | 'parent' = 'own') {
  const c = spawn(claudeBin('claude-bin', '/bin/bash'), ['-c', 'read -r _'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  children.push(c);
  const pid = c.pid!;
  record(pid, patch);
  writeFileSync(join(shim, 'pane_pid'), String(panePid(pane, pid)));
  return pid;
}
// Runs `cmd` in the sleep shim when send sleeps `arg` (2: before typing; 0.5: between the text and Enter).
function onSleep(arg: string, cmd: string) {
  const f = join(shim, `on-sleep-${arg}`);
  writeFileSync(f, `#!/bin/bash\n${cmd}\n`);
  chmodSync(f, 0o755);
}
// A commit on main with the switch off, left unreferenced: HEAD stays on the switch-on commit.
function offCommit() {
  const on = git(main, 'rev-parse', 'HEAD').trim();
  commitMain(false);
  const off = git(main, 'rev-parse', 'HEAD').trim();
  git(main, 'update-ref', 'HEAD', on);
  return off;
}
function flag(
  pid: number,
  { tick = startOf(pid), epoch = Math.floor(Date.now() / 1000), at = AT } = {},
) {
  mkdirSync(flagDir(), { recursive: true });
  writeFileSync(join(flagDir(), `${pid}.req`), `1 ${tick} ${epoch} ${at}\n`);
}
function stop(pid: number) {
  return spawnSync('bash', [join(main, 'scripts/board/self-compact.sh'), 'stop', String(pid)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}
const settle = async (until: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !until()) await new Promise((r) => setTimeout(r, 50));
  // send is detached: give a late send a moment to show up before asserting "nothing"
  await new Promise((r) => setTimeout(r, 150));
};
const finished = () => /\b(sent|skip)\b/.test(log());

describe.skipIf(!existsSync('/proc/self/stat'))('self-compact.sh', () => {
  describe('request', () => {
    it('writes the flag at a lane boundary with an empty box', async () => {
      const r = await request();
      expect(r.out).toBe('self-compact: requested; end the turn now\n');
      expect(r.code).toBe(0);
      const f = readFileSync(join(flagDir(), `${r.pid}.req`), 'utf8');
      expect(f).toMatch(new RegExp(`^1 ${r.tick} \\d+ ${AT}\\n$`));
      expect(log()).toMatch(new RegExp(`request pid=${r.pid} branch=${BRANCH}`));
    });

    it('succeeds mid-turn, under the working footer (request is a tool call in a running turn)', async () => {
      screens(
        screen('', { footer: ['  ⏵⏵ bypass permissions on · esc to interrupt · ↓ to manage'] }),
      );
      expect((await request()).code).toBe(0);
    });

    it("succeeds when the pane's process is claude's parent (the shell that started it)", async () => {
      expect((await request({ pane: 'parent' })).out).toBe(
        'self-compact: requested; end the turn now\n',
      );
    });

    it.each([
      ['off: main commits selfCompact false', () => commitMain(false), 'off'],
      ['off: selfCompact "true" is not a boolean', () => commitMain('true'), 'off'],
      [
        'the off-file, switch on',
        () => {
          mkdirSync(flagDir(), { recursive: true });
          writeFileSync(join(flagDir(), 'off'), '');
        },
        'off',
      ],
      [
        'switched on only in main working copy (not committed)',
        () => {
          commitMain(false);
          writeFileSync(
            join(main, 'scripts/board/limits.json'),
            JSON.stringify({ lanes: { selfCompact: true } }),
          );
        },
        'off',
      ],
      ['a stale lane file (11 min)', () => lane(11), 'lane-file-stale'],
      ['no lane file', () => rmSync(join(board, 'lanes', `${BRANCH}.json`)), 'lane-file-stale'],
      ['a dirty tree', () => writeFileSync(join(wt, 'new.txt'), 'x'), 'dirty'],
      ['text in the box', () => screens(screen('half a prompt')), 'box-other'],
      ['no box on screen (a dialog)', () => screens('❯ 1. Yes\n  2. No\n'), 'box-none'],
      [
        'a multi-line draft over an older empty box',
        () => screens(`${EMPTY}\n\n${RULE}\n❯${NBSP}line one\n  line two\n${RULE}\n  footer`),
        'box-none',
      ],
    ])('refuses: %s', async (_name, arrange, reason) => {
      arrange();
      const r = await request();
      expect(r.code).toBe(1);
      expect(r.out).toBe(`self-compact: refused (${reason})\n`);
      expect(existsSync(join(flagDir(), `${r.pid}.req`))).toBe(false);
      expect(log()).toMatch(new RegExp(`refuse pid=\\S* branch=(lane-x|-) reason=${reason}\\n`));
    });

    it('a replace ref on main (refs/replace/) cannot switch it on', async () => {
      const on = git(main, 'rev-parse', 'HEAD').trim();
      commitMain(false);
      git(main, 'replace', git(main, 'rev-parse', 'HEAD').trim(), on);
      expect((await request()).out).toBe('self-compact: refused (off)\n');
    });

    it('off writes no flag dir at all', async () => {
      commitMain(false);
      await request();
      expect(existsSync(flagDir())).toBe(false);
    });

    it('refuses in the handoff fork', async () => {
      const r = await request({ env: { APERTURE_HANDOFF_FORK: '1' } });
      expect(r.out).toBe('self-compact: refused (fork)\n');
    });

    it('refuses with no board record, or one for an earlier process', async () => {
      expect((await request({ record: null })).out).toBe('self-compact: refused (no-record)\n');
      expect((await request({ record: { pidStart: '1' } })).out).toBe(
        'self-compact: refused (no-record)\n',
      );
      expect((await request({ record: { lastPromptAt: null } })).out).toBe(
        'self-compact: refused (no-record)\n',
      );
    });

    it('refuses another pane, a malformed or missing TMUX_PANE', async () => {
      expect((await request({ pane: 'other' })).out).toBe('self-compact: refused (pane)\n');
      expect((await request({ env: { TMUX_PANE: '%x' } })).out).toBe(
        'self-compact: refused (pane)\n',
      );
      expect((await request({ env: { TMUX_PANE: '' } })).out).toBe(
        'self-compact: refused (pane)\n',
      );
    });

    it('refuses outside a lane worktree: main itself', async () => {
      const r = await request({ cwd: main });
      expect(r.out).toBe('self-compact: refused (not-lane)\n');
    });

    // The hub's name comes from the temp main's hub.json ('dispatch'); each clause alone.
    it('refuses the hub: by branch, by worktree dir and by the record name', async () => {
      const byBranch = join(main, '.claude/worktrees/lane-hub');
      git(main, 'worktree', 'add', '-q', '-b', 'dispatch', byBranch);
      const byDir = join(main, '.claude/worktrees/dispatch');
      git(main, 'worktree', 'add', '-q', '-b', 'other', byDir);
      mkdirSync(join(board, 'lanes'), { recursive: true });
      for (const b of ['dispatch', 'other']) writeFileSync(join(board, 'lanes', `${b}.json`), '{}');
      expect((await request({ cwd: byBranch })).out).toBe('self-compact: refused (hub)\n');
      expect((await request({ cwd: byDir })).out).toBe('self-compact: refused (hub)\n');
      expect((await request({ record: { name: 'dispatch' } })).out).toBe(
        'self-compact: refused (hub)\n',
      );
    });

    it('sweeps old flags, claims and write leftovers', async () => {
      mkdirSync(flagDir(), { recursive: true });
      const t = Date.now() / 1000 - 16 * 60;
      for (const f of ['424242.req', '424242.claim.99', '424242.req.tmp.7']) {
        writeFileSync(join(flagDir(), f), 'x');
        utimesSync(join(flagDir(), f), t, t);
      }
      const r = await request();
      expect(readdirSync(flagDir())).toEqual([`${r.pid}.req`]);
    });

    it('refuses with no claude ancestor', async () => {
      // setsid -f re-parents the script away from this test's own process tree (which may run under Claude Code)
      const out = join(tmp, 'no-claude.out');
      spawnSync(
        'setsid',
        [
          '-f',
          'bash',
          '-c',
          'bash "$0" request >"$1"; echo "rc=$?" >>"$1"',
          join(wt, 'scripts/board/self-compact.sh'),
          out,
        ],
        {
          cwd: wt,
          env,
        },
      );
      await settle(() => existsSync(out) && readFileSync(out, 'utf8').includes('rc='));
      expect(readFileSync(out, 'utf8')).toBe('self-compact: refused (no-claude)\nrc=1\n');
    });
  });

  describe('the box', () => {
    it('reads the 2.1.329 idle shape as empty, and ignores busy text quoted far above the box', async () => {
      const quoted = ['esc to interrupt', 'background agent', '1', '2', '3', '4', '5'];
      const pid = session();
      flag(pid);
      screens(screen('', { above: quoted }), screen('/compact', { above: quoted }));
      stop(pid);
      await settle(finished);
      expect(log()).toContain('sent pid=');
    });

    it('uses the last box: an earlier ❯ line in scrollback is ignored', async () => {
      screens(`${screen('old text')}\n\n${EMPTY}`);
      expect((await request()).code).toBe(0);
      screens(`${EMPTY}\n\n${screen('new text')}`);
      expect((await request()).out).toBe('self-compact: refused (box-other)\n');
    });
  });

  describe('stop → send', () => {
    it('types /compact into its own pane, then Enter once the box shows it', async () => {
      const pid = session({}, 'parent');
      flag(pid);
      const r = stop(pid);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      await settle(finished);
      expect(sends()).toEqual([`send-keys|-t|${PANE}|-l|/compact|`, `send-keys|-t|${PANE}|Enter|`]);
      expect(log()).toMatch(/claim pid=\d+ .*\n.*spawn pid=.*\n.*sent pid=/);
      expect(existsSync(join(flagDir(), `${pid}.req`))).toBe(false);
      // every tmux call aimed at the session's own pane
      for (const l of tmuxLog().trim().split('\n')) expect(l).toContain(`|-t|${PANE}|`);
    });

    it('two concurrent Stops send exactly once', async () => {
      const pid = session();
      flag(pid);
      const run = () =>
        new Promise<void>((res) => {
          const c = spawn(
            'bash',
            [join(main, 'scripts/board/self-compact.sh'), 'stop', String(pid)],
            {
              env,
            },
          );
          c.on('exit', () => res());
        });
      await Promise.all([run(), run(), run()]);
      await settle(finished);
      await new Promise((r) => setTimeout(r, 300));
      expect(sends().filter((l) => l.includes('|-l|'))).toHaveLength(1);
      expect(sends().filter((l) => l.endsWith('|Enter|'))).toHaveLength(1);
      expect(log().match(/ claim /g)).toHaveLength(1);
    });

    it('returns at once while send still waits (detached)', () => {
      const pid = session();
      flag(pid);
      const t = Date.now();
      const r = spawnSync(
        'bash',
        [join(main, 'scripts/board/self-compact.sh'), 'stop', String(pid)],
        {
          env: { ...env, SLOW_SLEEP: '10' },
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        },
      );
      expect(r.status).toBe(0);
      expect(Date.now() - t).toBeLessThan(5000);
      expect(sends()).toEqual([]);
    });

    it('no Enter when the box does not show /compact after typing', async () => {
      const pid = session();
      flag(pid);
      screens(EMPTY, screen('/compactx'));
      stop(pid);
      await settle(finished);
      expect(sends()).toEqual([`send-keys|-t|${PANE}|-l|/compact|`]);
      expect(log()).toMatch(/skip pid=\d+ branch=\S+ reason=box-changed/);
    });

    it.each([
      ['the box holds text', () => screens(screen('hello')), 'box-other'],
      [
        'the session is busy',
        () => screens(screen('', { footer: ['esc to interrupt'] })),
        'box-busy',
      ],
      [
        'a background agent running',
        () => screens(screen('', { above: ['✻ Waiting for 1 background agent to finish'] })),
        'box-busy',
      ],
      [
        'a subagent list (to manage)',
        () => screens(screen('', { footer: ['  ↓ to manage'] })),
        'box-busy',
      ],
    ])('sends nothing when %s', async (_n, arrange, reason) => {
      const pid = session();
      flag(pid);
      arrange();
      stop(pid);
      await settle(finished);
      expect(sends()).toEqual([]);
      expect(log()).toContain(`reason=${reason}`);
    });

    it('sends nothing when the board says working by the time send runs', async () => {
      const pid = session({ state: 'working' });
      flag(pid);
      stop(pid);
      await settle(finished);
      expect(sends()).toEqual([]);
      expect(log()).toContain('reason=guard');
    });

    // Each other clause of send's guard alone, changed in the 2 s before typing.
    it.each([
      ['the off-file appears', () => `mkdir -p ${flagDir()} && touch ${join(flagDir(), 'off')}`],
      ['main commits the switch off', () => `git -C ${main} update-ref HEAD ${offCommit()}`],
      ['the pane changes hands', () => `echo 1 >${join(shim, 'pane_pid')}`],
      [
        'a prompt arrives',
        (pid: number) => {
          const f = join(board, 'sessions', `${pid}.json`);
          return `jq '.lastPromptAt = "2026-11-19T10:05:00Z"' ${f} >${f}.n && mv ${f}.n ${f}`;
        },
      ],
    ])('types nothing when %s before typing', async (_n, cmd) => {
      const pid = session();
      flag(pid);
      onSleep('2', cmd(pid));
      stop(pid);
      await settle(finished);
      expect(sends()).toEqual([]);
      expect(log()).toContain('reason=guard');
    });

    it('a send for an earlier process with the same pid (start tick) types nothing', async () => {
      const pid = session();
      spawnSync(
        'bash',
        [join(main, 'scripts/board/self-compact.sh'), 'send', String(pid), '1', AT],
        {
          env,
          stdio: 'ignore',
        },
      );
      await settle(finished);
      expect(sends()).toEqual([]);
      expect(log()).toContain('reason=guard');
    });

    it('no Enter when the guard fails between the text and Enter', async () => {
      const pid = session();
      flag(pid);
      const f = join(board, 'sessions', `${pid}.json`);
      onSleep('0.5', `jq '.state = "working"' ${f} >${f}.n && mv ${f}.n ${f}`);
      stop(pid);
      await settle(finished);
      expect(sends()).toEqual([`send-keys|-t|${PANE}|-l|/compact|`]);
      expect(log()).toContain('reason=guard');
    });

    it('types nothing when send runs late (a loaded box)', async () => {
      const pid = session();
      flag(pid);
      spawnSync('bash', [join(main, 'scripts/board/self-compact.sh'), 'stop', String(pid)], {
        env: { ...env, SLOW_SLEEP: '9' },
        stdio: 'ignore',
      });
      await settle(finished, 14_000);
      expect(sends()).toEqual([]);
      expect(log()).toContain('reason=late');
    });

    it.each([
      [
        'a prompt since the request',
        (pid: number) => record(pid, { lastPromptAt: '2026-11-19T10:05:00Z' }),
        'prompted',
      ],
      [
        'a flag from an earlier process (tick)',
        (pid: number) => flag(pid, { tick: '1' }),
        'pid-changed',
      ],
      [
        'a flag older than 10 min',
        (pid: number) => flag(pid, { epoch: Math.floor(Date.now() / 1000) - 700 }),
        'stale-flag',
      ],
      [
        'a malformed flag',
        (pid: number) => writeFileSync(join(flagDir(), `${pid}.req`), '1 x\n'),
        'bad-flag',
      ],
      ['a dirty tree', () => writeFileSync(join(wt, 'new.txt'), 'x'), 'dirty'],
      ['another pane', () => writeFileSync(join(shim, 'pane_pid'), '1'), 'pane'],
      [
        'a record cwd outside the charset',
        (pid: number) => record(pid, { cwd: `${wt} x` }),
        'bad-cwd',
      ],
    ])('claims, then skips: %s', async (_n, arrange, reason) => {
      const pid = session();
      flag(pid);
      arrange(pid);
      const r = stop(pid);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      await settle(() => false, 300);
      expect(log()).toContain(`skip pid=${pid} branch=`);
      expect(log()).toContain(`reason=${reason}`);
      expect(sends()).toEqual([]);
      expect(existsSync(join(flagDir(), `${pid}.req`))).toBe(false);
    });

    it('reads no stdin: an open, silent stdin never holds it (the claim path)', async () => {
      const pid = session();
      flag(pid);
      const c = spawn('bash', [join(main, 'scripts/board/self-compact.sh'), 'stop', String(pid)], {
        env,
      });
      children.push(c);
      const code = await new Promise<number>((r) => c.on('close', (n) => r(n ?? -1)));
      expect(code).toBe(0);
      expect(existsSync(join(flagDir(), `${pid}.req`))).toBe(false); // claimed: it got past the flag check
    });

    it('switched off between request and Stop: nothing claimed or sent', async () => {
      const pid = session();
      flag(pid);
      commitMain(false);
      stop(pid);
      await settle(() => false, 300);
      expect(existsSync(join(flagDir(), `${pid}.req`))).toBe(true);
      expect(sends()).toEqual([]);
      expect(log()).toBe('');
    });

    it('sweeps flags, claims and write leftovers older than 15 min', () => {
      const pid = session();
      mkdirSync(flagDir(), { recursive: true });
      const t = Date.now() / 1000 - 16 * 60;
      for (const f of ['424242.req', '424242.claim.99', '424242.req.tmp.7']) {
        writeFileSync(join(flagDir(), f), '1 1 1 2026-11-19T10:00:00Z\n');
        utimesSync(join(flagDir(), f), t, t);
      }
      stop(pid);
      expect(readdirSync(flagDir())).toEqual([]);
    });

    it('a pid that is not a claude process: silent, untouched', () => {
      const c = spawn('sleep', ['300'], { stdio: 'ignore' });
      children.push(c);
      flag(c.pid!);
      const r = stop(c.pid!);
      expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
      expect(existsSync(join(flagDir(), `${c.pid}.req`))).toBe(true);
    });
  });

  it.each([[[]], [['--help']], [['stop']], [['send', '1']], [['bogus']]])(
    'usage %j exits 2 and acts on nothing',
    (args) => {
      const r = spawnSync('bash', [join(main, 'scripts/board/self-compact.sh'), ...args], {
        env,
        encoding: 'utf8',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^usage: self-compact.sh/);
      expect(log()).toBe('');
      expect(tmuxLog()).toBe('');
    },
  );

  it('the tracked limits.json ships the switch off', () => {
    const l = JSON.parse(readFileSync(join(boardSrc, 'limits.json'), 'utf8'));
    expect(l.lanes.selfCompact).toBe(false);
  });
});
