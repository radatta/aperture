import { describe, expect, it } from 'vitest';
import { parseBench } from './bench.ts';

const HEAD =
  'ts\tcell\tmw\twc\tmode\trep\twt\texit\twall_s\tfailed_files\ttimeouts\tsolo_rerun\theavy_line\n';

describe('parseBench', () => {
  it('is empty with only the header, and takes the state from the log', () => {
    expect(parseBench(HEAD, '21:50:38 waiting for quiet\n22:00:59 waiting for quiet\n')).toEqual({
      rows: [],
      runs: 0,
      failedRows: 0,
      state: '22:00:59 waiting for quiet',
    });
  });

  it('counts a pair run once and flags red rows', () => {
    const b = parseBench(
      HEAD +
        'x\tmwdef-wcdef\tdef\tdef\tsolo\t1\tA\t0\t62\t0\t0\t\t\n' +
        'x\tmwdef-wcdef\tdef\tdef\tpair\t1\tA\t0\t95\t0\t0\t\t\n' +
        'x\tmwdef-wcdef\tdef\tdef\tpair\t1\tB\t1\t97\t2\t1\t\t\n',
      null,
    );
    expect(b.runs).toBe(2);
    expect(b.failedRows).toBe(1);
    expect(b.rows[2]).toEqual({
      cell: 'mwdef-wcdef',
      mode: 'pair',
      rep: '1',
      wallSec: 97,
      failedFiles: 2,
      timeouts: 1,
      exit: 1,
    });
    expect(b.state).toBeNull();
  });
});
