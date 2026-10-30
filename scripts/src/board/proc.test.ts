import { describe, it, expect } from 'vitest';
import { parseCpuMax, parseKv, parseLimit, parsePsi, parseStat } from './proc.ts';

const stat = (pid: number, comm: string) =>
  `${pid} (${comm}) S 1272 63246 63246 0 -1 4194304 393 1253 0 0 7 3 2 1 20 0 15 0 8435859 7778304 124280 18446744073709551615 0 0 0`;

describe('parseStat', () => {
  it('reads the fields after the last paren', () => {
    expect(parseStat(stat(16754, 'claude'))).toEqual({
      pid: 16754,
      comm: 'claude',
      state: 'S',
      ppid: 1272,
      cpuTicks: 13,
      threads: 15,
      startTime: '8435859',
      rssPages: 124280,
    });
  });

  it('survives spaces and parens inside comm', () => {
    expect(parseStat(stat(1272, 'tmux: server'))?.comm).toBe('tmux: server');
    expect(parseStat(stat(900, '(sd-pam)'))).toMatchObject({
      comm: '(sd-pam)',
      ppid: 1272,
      threads: 15,
    });
    expect(parseStat(stat(901, 'a) b (c'))).toMatchObject({
      comm: 'a) b (c',
      startTime: '8435859',
    });
  });

  it('rejects truncated lines', () => {
    expect(parseStat('12 (x) S 1 2')).toBeNull();
    expect(parseStat('garbage')).toBeNull();
  });
});

describe('cgroup parsers', () => {
  it('parses key/value files', () => {
    expect(parseKv('anon 1939865600\nfile 136314880\nbad\n')).toEqual({
      anon: 1939865600,
      file: 136314880,
    });
    expect(parseKv('low 0\nhigh 3\noom_kill 0\n')).toMatchObject({ high: 3, oom_kill: 0 });
  });

  it('parses PSI lines', () => {
    const p = parsePsi(
      'some avg10=1.50 avg60=0.20 avg300=0.00 total=22\nfull avg10=0.75 avg60=0.10 avg300=0.00 total=16\n',
    );
    expect(p.some).toEqual({ avg10: 1.5, avg60: 0.2, avg300: 0, total: 22 });
    expect(p.full?.avg10).toBe(0.75);
    expect(parsePsi('some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n').full).toBeNull(); // cpu.pressure on older kernels
  });

  it('parses cpu.max both spellings', () => {
    expect(parseCpuMax('max 100000\n')).toEqual({ quotaUs: null, periodUs: 100000 });
    expect(parseCpuMax('720000 100000\n')).toEqual({ quotaUs: 720000, periodUs: 100000 });
  });

  it('treats max as unlimited', () => {
    expect(parseLimit('max\n')).toBeNull();
    expect(parseLimit('19327352832\n')).toBe(19327352832);
  });
});
