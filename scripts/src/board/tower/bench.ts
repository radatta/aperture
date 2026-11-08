// The overnight vitest bench (localNotes/bench-vitest/): results.tsv rows and bench.log's last line.

export type BenchRow = {
  cell: string;
  mode: string;
  rep: string;
  wallSec: number;
  failedFiles: number;
  timeouts: number;
  exit: number;
};
export type Bench = { rows: BenchRow[]; runs: number; failedRows: number; state: string | null };

export function parseBench(tsv: string, log: string | null): Bench {
  const lines = tsv.split('\n').filter((l) => l.trim());
  const head = (lines.shift() ?? '').split('\t');
  const rows: BenchRow[] = [];
  for (const l of lines) {
    const f = l.split('\t');
    const s = (name: string) => f[head.indexOf(name)] ?? '';
    const n = (name: string) => Number(s(name) || NaN);
    if (!s('cell')) continue;
    rows.push({
      cell: s('cell'),
      mode: s('mode'),
      rep: s('rep'),
      wallSec: n('wall_s'),
      failedFiles: n('failed_files') || 0,
      timeouts: n('timeouts') || 0,
      exit: n('exit'),
    });
  }
  const last =
    log
      ?.split('\n')
      .filter((l) => l.trim())
      .pop() ?? null;
  return {
    rows,
    runs: new Set(rows.map((r) => `${r.cell} ${r.mode} ${r.rep}`)).size, // a pair run writes two rows
    failedRows: rows.filter((r) => r.exit !== 0 || r.failedFiles > 0 || r.timeouts > 0).length,
    state: last,
  };
}
