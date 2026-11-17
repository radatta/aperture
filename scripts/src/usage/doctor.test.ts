import { describe, expect, it } from 'vitest';
import { doctor, formatDoctor, SOURCING_LINE } from './doctor.ts';

const NOW = Date.parse('2026-01-10T12:00:00Z');
const good = {
  settings: JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/sl.sh' } }),
  statusline: `#!/usr/bin/env bash\necho hi\n${SOURCING_LINE}\n`,
  newestRowTs: '2026-01-10T11:58:00Z',
  now: NOW,
};

describe('doctor', () => {
  it('passes when the key, the sourcing line and a fresh row are all there', () => {
    expect(doctor(good).every((c) => c.ok)).toBe(true);
    expect(formatDoctor(doctor(good))).not.toContain('FAIL');
  });

  it('flags a settings file the restart re-seeded without statusLine, or one that is missing or broken', () => {
    for (const settings of [JSON.stringify({ permissions: {} }), null, '{oops'])
      expect(doctor({ ...good, settings })[0]).toMatchObject({ ok: false });
  });

  it('flags a status line that never sources the logger, or only mentions it in a comment', () => {
    expect(doctor({ ...good, statusline: 'echo hi\n' })[1]!.ok).toBe(false);
    expect(doctor({ ...good, statusline: '# statusline-log.sh removed\n' })[1]!.ok).toBe(false);
    expect(doctor({ ...good, statusline: null })[1]!.fix).toContain(SOURCING_LINE);
  });

  it('flags a stale or missing log with its age', () => {
    expect(doctor({ ...good, newestRowTs: '2026-01-10T11:30:00Z' })[2]!.fix).toContain(
      '30 min old',
    );
    expect(doctor({ ...good, newestRowTs: null })[2]!.fix).toContain('no meter rows');
  });
});
