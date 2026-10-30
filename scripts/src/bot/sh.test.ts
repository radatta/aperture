import { describe, it, expect } from 'vitest';
import { run } from './sh.ts';

const fail = (script: string) => () => run(process.execPath, ['-e', script]);

describe('run', () => {
  it('returns trimmed stdout', () => {
    expect(run(process.execPath, ['-e', "process.stdout.write('  ok\\n')"])).toBe('ok');
  });

  // `git push --porcelain` puts a rejected ref's reason on stdout; dropping it hid why a push failed
  it('puts stdout and stderr in the error', () => {
    expect(
      fail(
        "process.stdout.write('! [remote rejected] (no workflows permission)'); process.stderr.write('error: failed to push'); process.exit(1)",
      ),
    ).toThrow(/failed: ! \[remote rejected\] \(no workflows permission\)\nerror: failed to push$/);
  });

  it('keeps stderr alone when stdout is empty', () => {
    expect(fail("process.stderr.write('boom'); process.exit(1)")).toThrow(/failed: boom$/);
  });
});
