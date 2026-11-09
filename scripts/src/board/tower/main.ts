// The control tower (docs/ops/SESSION-BOARD.md → Control tower): `scripts/board/tower.sh [flags]`.
//   --fixtures <dir>   read <dir>/board, <dir>/ledger.{dev,devb}.jsonl, <dir>/bench, <dir>/prs.json (proof captures)
//   --now <iso>        a fixed clock          --no-gh       no `gh pr list`
//   --once <cols>x<rows>  print one frame and exit (no terminal needed)
//   --measure          per-tick cost on stderr
//   --svg <in> <out>   render a `tmux capture-pane -e -p` file to SVG
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only, no dependencies.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Range } from './model.ts';
import { chartCols, compose, type Ui } from './panels.ts';
import { PrCache, ghFetch, type Fetch } from './prs.ts';
import { Screen, decodeKeys, type Key } from './screen.ts';
import { Source, defaultPaths, type Paths } from './source.ts';
import { ansiToSvg } from './svg.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TICK_MS = 5000;
const DEVLOCK_MS = 60000;

export type Args = {
  fixtures: string | null;
  now: number | null;
  gh: boolean;
  once: [number, number] | null;
  measure: boolean;
  svg: [string, string] | null;
};

export function parseArgs(argv: string[]): Args {
  const a: Args = { fixtures: null, now: null, gh: true, once: null, measure: false, svg: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fixtures') a.fixtures = resolve(argv[++i] ?? '.');
    else if (k === '--now') a.now = Date.parse(argv[++i] ?? '');
    else if (k === '--no-gh') a.gh = false;
    else if (k === '--measure') a.measure = true;
    else if (k === '--once') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] ?? '');
      if (!m) throw new Error('--once wants <cols>x<rows>');
      a.once = [Number(m[1]), Number(m[2])];
    } else if (k === '--svg') a.svg = [argv[++i] ?? '', argv[++i] ?? ''];
    else throw new Error(`unknown flag ${k}`);
  }
  if (a.now !== null && Number.isNaN(a.now)) throw new Error('--now wants an ISO time');
  return a;
}

export function fixturePaths(dir: string): Paths {
  return {
    boardDir: join(dir, 'board'),
    limits: join(REPO, 'scripts/board/limits.json'),
    ledger: join(dir, 'ledger.dev.jsonl'),
    ledgerB: join(dir, 'ledger.devb.jsonl'),
    bench: join(dir, 'bench'),
    cores: 9, // recorded on the 9-core container: the frame must not depend on the host (CI has 2)
  };
}

export function build(a: Args) {
  const fetch: Fetch | null = a.fixtures
    ? async () => readFileSync(join(a.fixtures!, 'prs.json'), 'utf8')
    : a.gh
      ? ghFetch
      : null;
  const prs = fetch ? new PrCache(fetch) : null;
  const source = new Source(a.fixtures ? fixturePaths(a.fixtures) : defaultPaths(REPO), prs);
  const clock = () => a.now ?? Date.now();
  return { prs, source, clock };
}

async function once(a: Args) {
  const { prs, source, clock } = build(a);
  await prs?.poll(clock());
  const [cols, rows] = a.once!;
  process.stdout.write(
    compose(source.refresh(clock()), { range: '1h', cursor: 0 }, cols, rows).join('\x1b[0m\n') +
      '\x1b[0m\n',
  );
}

function run(a: Args) {
  const { prs, source, clock } = build(a);
  const out = process.stdout;
  const screen = new Screen(out);
  const ui: Ui = { range: '1h', cursor: 0 };
  let state = source.refresh(clock());
  let devlockAt = 0;

  const render = () => {
    const t0 = performance.now();
    const n = screen.draw(compose(state, ui, out.columns || 100, out.rows || 40));
    return { ms: performance.now() - t0, n };
  };
  const tick = () => {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    const now = clock();
    state = source.refresh(now);
    const r = render();
    void prs
      ?.poll(now)
      .then(() => (state = { ...state, prs: { list: prs.list, at: prs.at, error: prs.error } }));
    if (!a.fixtures && now - devlockAt >= DEVLOCK_MS) {
      devlockAt = now;
      // the board's own lock peek, which rewrites both slots' caches (devlock.json, devlock.devb.json); 50, not
      // 60: the cache is stamped after the peek, so a minute later it is ~59 s old and a 60 s max-age would skip
      // every other minute
      execFile(
        'bash',
        [join(REPO, 'scripts/board/devlock.sh'), 'refresh', '--max-age', '50'],
        { timeout: 15000 },
        () => {},
      );
    }
    if (a.measure) {
      const u = process.cpuUsage(c0);
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      process.stderr.write(
        `tick ${(performance.now() - t0).toFixed(1)}ms wall · ${((u.user + u.system) / 1000).toFixed(1)}ms cpu · render ${r.ms.toFixed(1)}ms ${r.n} rows · rss ${rss}MiB · ${state.points.length} points ${state.jobs.length} jobs\n`,
      );
    }
  };

  let done = false;
  const quit = (code = 0) => {
    if (done) return;
    done = true;
    screen.restore();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(code);
  };
  process.on('exit', () => screen.restore());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => quit(0));
  process.on('uncaughtException', (e) => {
    screen.restore();
    process.stderr.write(`tower: ${e.stack ?? e}\n`);
    process.exit(1);
  });
  process.on('SIGWINCH', () => {
    ui.cursor = Math.min(
      ui.cursor,
      Math.max(0, chartCols(state, out.columns || 100, out.rows || 40) - 1),
    );
    screen.invalidate();
    render();
  });

  const onKey = (k: Key) => {
    const last = Math.max(0, chartCols(state, out.columns || 100, out.rows || 40) - 1); // the oldest cell
    if (k === 'quit') return quit(0);
    if (k === '1h' || k === '6h' || k === '24h') ui.range = k as Range;
    else if (k === 'left') ui.cursor = Math.min(last, ui.cursor + 1);
    else if (k === 'right') ui.cursor = Math.max(0, ui.cursor - 1);
    else if (k === 'live') ui.cursor = 0;
    else if (k === 'oldest') ui.cursor = last;
    else if (k === 'refresh') return tick();
    render();
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => decodeKeys(d).forEach(onKey));
  }

  screen.enter();
  tick();
  setInterval(tick, TICK_MS);
}

export function main(argv: string[]) {
  const a = parseArgs(argv);
  if (a.svg) {
    const [inp, outp] = a.svg;
    writeFileSync(outp, ansiToSvg(readFileSync(inp, 'utf8')));
    return;
  }
  if (a.once) return void once(a);
  run(a);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`tower: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
