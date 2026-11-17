import { describe, expect, it } from 'vitest';
import { MainBusy } from './main-lock.ts';
import { FETCH_TIMEOUT_MS, execRun, syncMain, type Run } from './sync-main.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const MAIN = '/repo';

type World = {
  dirty?: string;
  branch?: string;
  fetchFails?: boolean;
  head: string;
  origin: string;
  tower?: 'running' | 'stopped';
  served?: string | null; // null: `tower version` fails (an older server)
  changed?: Record<string, string[] | 'fail'>; // `${from}..${to}` → tower files
  restartFails?: boolean;
  switchFails?: boolean;
};

function fake(w: World) {
  const calls: { cmd: string; args: string[]; cwd: string; timeoutMs?: number }[] = [];
  const run: Run = (cmd, args, cwd, timeoutMs) => {
    calls.push({ cmd, args, cwd, timeoutMs });
    if (cmd === 'bash') {
      const sub = args[2];
      if (sub === 'status') {
        if (w.tower === 'stopped') throw new Error('exit 1');
        return 'tower: running (pid 9)';
      }
      if (sub === 'version') {
        if (w.served === null) throw new Error('exit 2');
        return `${w.served ?? ''}\n`;
      }
      if (sub === 'restart') {
        if (w.restartFails) throw new Error('did not start');
        return 'tower: started';
      }
      throw new Error(`unexpected board.sh ${sub}`);
    }
    const [g, ...rest] = args;
    switch (g) {
      case 'rev-parse':
        if (rest[0] === '--path-format=absolute') return `${MAIN}/.git\n`;
        return `${rest[0] === 'origin/main' ? w.origin : w.head}\n`;
      case 'status':
        return w.dirty ?? '';
      case 'symbolic-ref':
        if (!w.branch) throw new Error('exit 1');
        return w.branch;
      case 'fetch':
        if (w.fetchFails) throw new Error('network');
        return '';
      case 'switch':
        if (w.switchFails) throw new Error('untracked file would be overwritten');
        w.head = rest[1]!;
        return '';
      case 'diff': {
        const c = w.changed?.[`${rest[1]}..${rest[2]}`] ?? [];
        if (c === 'fail') throw new Error('bad object');
        return c.join('\n');
      }
    }
    throw new Error(`unexpected git ${g}`);
  };
  const did = (s: string) => calls.some((c) => c.args.includes(s));
  return { run, calls, did };
}

describe('sync-main', () => {
  it('moves the main checkout and restarts the tower when its code changed, in that order', () => {
    const f = fake({
      head: A,
      origin: B,
      tower: 'running',
      served: A,
      changed: { [`${A}..${B}`]: ['scripts/board/board.sh'] },
    });
    expect(syncMain(f.run, '/repo/.claude/worktrees/x')).toBe(
      'main checkout: moved aaaaaaa → bbbbbbb\ntower: restarted (1 tower file changed since aaaaaaa)',
    );
    const order = f.calls
      .map((c) => c.args.find((a) => ['switch', 'restart'].includes(a)))
      .filter(Boolean);
    expect(order).toEqual(['switch', 'restart']);
    // every git call runs in the main checkout, not the worktree it was typed in
    expect(f.calls.slice(1).every((c) => c.cwd === MAIN)).toBe(true);
    expect(f.calls.find((c) => c.args[0] === 'switch')!.args).toEqual(['switch', '--detach', B]);
  });

  it('moves without a restart when no tower file changed', () => {
    const f = fake({ head: A, origin: B, tower: 'running', served: A });
    expect(syncMain(f.run, MAIN)).toBe(
      'main checkout: moved aaaaaaa → bbbbbbb\ntower: restart not needed (serving aaaaaaa)',
    );
    expect(f.did('restart')).toBe(false);
  });

  it('is a no-op when everything is current', () => {
    const f = fake({ head: B, origin: B, tower: 'running', served: B });
    expect(syncMain(f.run, MAIN)).toBe(
      'main checkout: already at bbbbbbb\ntower: restart not needed (serving bbbbbbb)',
    );
    expect(f.did('switch') || f.did('restart')).toBe(false);
  });

  it('restarts a tower serving an older commit even when the checkout already moved (pnpm lanes start detached it)', () => {
    const f = fake({
      head: B,
      origin: B,
      tower: 'running',
      served: C,
      changed: { [`${C}..${B}`]: ['a', 'b'] },
    });
    expect(syncMain(f.run, MAIN)).toBe(
      'main checkout: already at bbbbbbb\ntower: restarted (2 tower files changed since ccccccc)',
    );
  });

  it('restarts when the served commit is unknown: no record, or git does not know it', () => {
    expect(
      syncMain(fake({ head: B, origin: B, tower: 'running', served: null }).run, MAIN),
    ).toMatch(/restarted \(served commit unknown\)/);
    expect(syncMain(fake({ head: B, origin: B, tower: 'running', served: '' }).run, MAIN)).toMatch(
      /restarted \(served commit unknown\)/,
    );
    const f = fake({
      head: B,
      origin: B,
      tower: 'running',
      served: C,
      changed: { [`${C}..${B}`]: 'fail' },
    });
    expect(syncMain(f.run, MAIN)).toMatch(/restarted \(served ccccccc unknown to git\)/);
  });

  it('never starts a stopped tower', () => {
    const f = fake({ head: A, origin: B, tower: 'stopped' });
    expect(syncMain(f.run, MAIN)).toBe(
      'main checkout: moved aaaaaaa → bbbbbbb\ntower: not running (board.sh tower start)',
    );
    expect(f.did('restart') || f.did('start')).toBe(false);
  });

  it('refuses tracked changes before fetching; untracked files are fine', () => {
    const f = fake({ head: A, origin: B, dirty: ' M docs/x.md\n' });
    expect(() => syncMain(f.run, MAIN)).toThrow(/tracked changes — nothing moved:\n M docs\/x.md/);
    expect(f.did('fetch')).toBe(false);
    // `--untracked-files=no`: git itself leaves `?? .codex/` out of the porcelain list
    expect(f.calls.find((c) => c.args[0] === 'status')!.args).toContain('--untracked-files=no');
  });

  it('refuses a main checkout on a branch, and a failed fetch moves nothing', () => {
    expect(() => syncMain(fake({ head: A, origin: B, branch: 'main' }).run, MAIN)).toThrow(
      /on branch main, not detached/,
    );
    const f = fake({ head: A, origin: B, fetchFails: true });
    expect(() => syncMain(f.run, MAIN)).toThrow(/git fetch failed — nothing moved/);
    expect(f.did('switch')).toBe(false);
  });

  it('a failed switch says nothing moved and restarts nothing', () => {
    const f = fake({ head: A, origin: B, tower: 'running', served: null, switchFails: true });
    expect(() => syncMain(f.run, MAIN)).toThrow(
      /git switch failed — nothing moved: untracked file/,
    );
    expect(f.did('restart')).toBe(false);
  });

  it('a second run is a no-op', () => {
    const w: World = {
      head: A,
      origin: B,
      tower: 'running',
      served: A,
      changed: { [`${A}..${B}`]: ['x'] },
    };
    const f = fake(w);
    syncMain(f.run, MAIN);
    w.served = B; // the restarted server records the new commit
    f.calls.length = 0;
    expect(syncMain(f.run, MAIN)).toBe(
      'main checkout: already at bbbbbbb\ntower: restart not needed (serving bbbbbbb)',
    );
    expect(f.did('switch') || f.did('restart')).toBe(false);
  });

  it('a failed restart says what moved', () => {
    const f = fake({ head: A, origin: B, tower: 'running', served: null, restartFails: true });
    expect(() => syncMain(f.run, MAIN)).toThrow(
      /^main checkout: moved aaaaaaa → bbbbbbb\ntower: restart failed \(served commit unknown\): did not start/,
    );
  });

  // F155: a lanes start can't interleave with the move
  it('the dirty check through the switch run inside the lock, the tower restart outside', () => {
    const f = fake({
      head: A,
      origin: B,
      tower: 'running',
      served: A,
      changed: { [`${A}..${B}`]: ['x'] },
    });
    const marks: string[] = [];
    const locked = <T>(fn: () => T): T => {
      marks.push(`in@${f.calls.length}`);
      try {
        return fn();
      } finally {
        marks.push(`out@${f.calls.length}`);
      }
    };
    syncMain(f.run, MAIN, locked);
    const line = (c: { cmd: string; args: string[] }) =>
      `${c.cmd === 'git' ? 'git ' : ''}${c.args[c.cmd === 'git' ? 0 : 2]}`;
    const at = (m: string) => Number(marks.find((x) => x.startsWith(m))!.split('@')[1]);
    const inside = f.calls.slice(at('in'), at('out')).map(line);
    expect(inside[0]).toBe('git status');
    expect(inside).toContain('git fetch');
    expect(inside.at(-1)).toBe('git switch');
    expect(f.calls.slice(at('out')).map(line)).toContain('restart');
  });

  it('the fetch carries a 60 s timeout', () => {
    const f = fake({ head: A, origin: A, tower: 'stopped' });
    syncMain(f.run, MAIN);
    expect(f.calls.find((c) => c.args[0] === 'fetch')!.timeoutMs).toBe(FETCH_TIMEOUT_MS);
    expect(FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('the real runner kills a child past its timeout and says so', () => {
    expect(() => execRun('sleep', ['5'], '/', 200)).toThrow('sleep 5 timed out after 0.2 s');
  });

  it('a busy lock throws before any git write', () => {
    const f = fake({ head: A, origin: B, tower: 'running' });
    expect(() =>
      syncMain(f.run, MAIN, () => {
        throw new MainBusy('main checkout busy');
      }),
    ).toThrow(/main checkout busy/);
    expect(f.calls.map((c) => c.args[0])).toEqual(['rev-parse']);
  });
});
