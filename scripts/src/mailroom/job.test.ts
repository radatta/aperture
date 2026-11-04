import { describe, expect, it } from 'vitest';
import { ID_RE, makeId, makeOpenPrJob, sha256, validateJob, visible } from './job.ts';
import { buildJob, loadCases } from './fixtures.ts';

const NOW = Date.parse('2026-11-01T20:45:12Z');
const { base, cases } = loadCases();
const shared = cases.filter((c) => 'ts' in c);

describe('validateJob mirrors the Mac runner (tools/mailroom/testdata/jobs.jsonl)', () => {
  it('covers every reason the container checks', () => {
    const reasons = new Set(shared.map((c) => c.ts));
    for (const r of [
      'BAD_JSON',
      'BAD_ID',
      'UNKNOWN_JOB',
      'BAD_PARAM',
      'EXPIRED',
      'BAD_TEXT',
      'MENTION',
      'HASH_REF',
      'XREF',
      null,
    ])
      expect(reasons.has(r)).toBe(true);
  });

  it.each(shared.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { job, stem } = buildJob(base, c, NOW);
    expect(validateJob(job, stem, NOW)).toBe(c.ts);
  });
});

describe('job building', () => {
  it('ids match the runner pattern, even for a long branch', () => {
    expect(makeId('mac-mailroom', NOW, 'ab12')).toBe('20261101T204512Z-mac-mailroom-ab12');
    expect(makeId('x'.repeat(63), NOW)).toMatch(ID_RE);
  });

  it('a built job passes and carries the body hash', () => {
    const job = makeOpenPrJob(
      {
        branch: 'mac-mailroom',
        sha: 'a'.repeat(40),
        title: 'Mac mailroom opens PRs',
        body: 'Body with `@x`.',
      },
      NOW,
    );
    expect(validateJob(job, job.id, NOW)).toBeNull();
    expect(job.params.bodySha256).toBe(sha256('Body with `@x`.'));
    expect(job.submittedAt).toBe('2026-11-01T20:45:12Z');
  });

  it('wait plus grace stays under the Bash tool timeout', async () => {
    const { WAIT_MS } = await import('./open-pr.ts');
    expect(WAIT_MS + 30_000).toBeLessThan(120_000);
  });

  it('refuses a lone surrogate (jq would read it as U+FFFD)', () => {
    const job = makeOpenPrJob(
      { branch: 'b', sha: 'a'.repeat(40), title: 'Lone surrogate', body: 'x\ud800y' },
      NOW,
    );
    expect(validateJob(job, job.id, NOW)).toBe('BAD_TEXT');
  });

  it('visible() drops fenced blocks and exact-run code spans only', () => {
    expect(visible('a `@x` b ``@y`` c')).toBe('a   b   c');
    expect(visible('```sh\n@x\n```\nafter')).toBe('\n\nafter');
    expect(visible('`@x``')).toContain('@x');
  });
});
