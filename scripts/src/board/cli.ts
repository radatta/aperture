// Board CLI for the decisions that deserve tests (docs/ops/SESSION-BOARD.md). Called by scripts/board/*.sh:
//   node scripts/src/board/cli.ts decide-dev     < {current, req}                         → DevDecision
//   node scripts/src/board/cli.ts decide-heavy   < {limits, liveLimits, live, slots, req} → HeavyDecision
//   node scripts/src/board/cli.ts staleness <limits.json> <historyDir>                    → warning lines
// Plain `node` (Node 22 strips types; same as classify-changes.ts): erasable syntax, node: builtins only.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decideDev, decideHeavy, type Alive } from './lease.ts';
import { parseLimits, staleness } from './limits.ts';
import { parseLimit, parseStat } from './proc.ts';

const cgroup = process.env.APERTURE_CGROUP_DIR ?? '/sys/fs/cgroup';

export const procAlive: Alive = (pid, start) => {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.startTime === start;
  } catch {
    return false;
  }
};

function liveLimits() {
  const read = (f: string) => parseLimit(readFileSync(join(cgroup, f), 'utf8'));
  return {
    pidsMax: read('pids.max') ?? 4194304,
    highBytes: read('memory.high') ?? Number.MAX_SAFE_INTEGER,
  };
}

function readJsonl(dir: string, prefix: string): unknown[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as unknown];
        } catch {
          return []; // a torn last line from a concurrent append
        }
      }),
  );
}

export function main(argv: string[], stdin: () => string): string {
  const [cmd, ...args] = argv;
  const now = new Date();
  switch (cmd) {
    case 'decide-dev': {
      const { current, req } = JSON.parse(stdin());
      return JSON.stringify(decideDev(current ?? null, req, now, procAlive));
    }
    case 'decide-heavy': {
      const { limits, liveLimits: ll, live, slots, req } = JSON.parse(stdin());
      return JSON.stringify(decideHeavy(parseLimits(limits), ll, live, slots ?? [], req, now));
    }
    case 'staleness': {
      const [limitsPath, historyDir] = args;
      if (!limitsPath || !historyDir)
        throw new Error('usage: staleness <limits.json> <historyDir>');
      const limits = parseLimits(JSON.parse(readFileSync(limitsPath, 'utf8')));
      const events = readJsonl(historyDir, 'events-') as Parameters<typeof staleness>[2];
      return staleness(limits, liveLimits(), events, now).join('\n');
    }
    default:
      throw new Error(
        `usage: cli.ts decide-dev | decide-heavy | staleness (got ${cmd ?? 'nothing'})`,
      );
  }
}

if (process.argv[1]?.endsWith('cli.ts')) {
  try {
    const out = main(process.argv.slice(2), () => readFileSync(0, 'utf8'));
    if (out) process.stdout.write(out + '\n');
  } catch (e) {
    process.stderr.write(`board cli: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
