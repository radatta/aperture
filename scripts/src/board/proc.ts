// Parsers for /proc and cgroup v2 files (docs/ops/SESSION-BOARD.md → cheat sheet). Pure: callers read files.
// Runs under plain `node` (type stripping): erasable syntax, node: builtins only, `.ts` import extensions.

export type ProcStat = {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  cpuTicks: number; // utime + stime + cutime + cstime
  threads: number;
  startTime: string; // field 22 — with pid, defeats pid reuse
  rssPages: number;
};

// comm may hold spaces and parens (`tmux: server`, `(sd-pam)`), so split after the LAST `)`.
export function parseStat(line: string): ProcStat | null {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = line
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const n = (i: number) => Number(rest[i] ?? NaN);
  if (rest.length < 22) return null;
  return {
    pid: Number(line.slice(0, open).trim()),
    comm: line.slice(open + 1, close),
    state: rest[0] ?? '',
    ppid: n(1),
    cpuTicks: n(11) + n(12) + n(13) + n(14),
    threads: n(17),
    startTime: rest[19] ?? '',
    rssPages: n(21),
  };
}

// `key value` lines (memory.stat, memory.events, cpu.stat).
export function parseKv(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && /^-?\d+$/.test(v)) out[k] = Number(v);
  }
  return out;
}

export type Psi = { avg10: number; avg60: number; avg300: number; total: number };

export function parsePsi(text: string): { some: Psi | null; full: Psi | null } {
  const out: { some: Psi | null; full: Psi | null } = { some: null, full: null };
  for (const line of text.split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind !== 'some' && kind !== 'full') continue;
    const f: Record<string, number> = {};
    for (const kv of fields) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) f[k] = Number(v);
    }
    out[kind] = {
      avg10: f.avg10 ?? 0,
      avg60: f.avg60 ?? 0,
      avg300: f.avg300 ?? 0,
      total: f.total ?? 0,
    };
  }
  return out;
}

// cpu.max: `max 100000` (no quota) or `<quota> <period>`.
export function parseCpuMax(text: string): { quotaUs: number | null; periodUs: number } {
  const [q, p] = text.trim().split(/\s+/);
  return {
    quotaUs: q === 'max' || q === undefined ? null : Number(q),
    periodUs: Number(p ?? 100000),
  };
}

// Single-value files where `max` means unlimited (memory.high, memory.max, pids.max).
export function parseLimit(text: string): number | null {
  const v = text.trim();
  return v === 'max' || v === '' ? null : Number(v);
}
