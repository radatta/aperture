import { describe, expect, it } from 'vitest';
import {
  ID_RE,
  makeEditPrJob,
  makeId,
  makeOpenPrJob,
  sha256,
  validateJob,
  visible,
} from './job.ts';
import { baseFor, buildJob, loadCases } from './fixtures.ts';

const NOW = Date.parse('2026-11-01T20:45:12Z');
const bases = loadCases();
const { cases } = bases;
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
      'TOO_MANY_OPS',
      'BAD_OP',
      'DENIED_TAP',
      null,
    ])
      expect(reasons.has(r)).toBe(true);
  });

  it.each(shared.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { job, stem } = buildJob(baseFor(bases, c), c, NOW);
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

  it('an open-pr id is never named like a sim (the slow lane on the Mac takes …Z-ios-…)', () => {
    const j = (branch: string) =>
      makeOpenPrJob({ branch, sha: 'a'.repeat(40), title: 'T', body: 'b' }, NOW).id;
    expect(j('ios-probe-check')).toMatch(/^\d{8}T\d{6}Z-pr-ios-probe-check-[0-9a-f]{4}$/);
    expect(j('x'.repeat(4) + 'ios-y')).toMatch(/Z-xxxxios-y-/);
    for (const b of ['ios-' + 'x'.repeat(60), 'ios-a', 'mac-mailroom']) {
      expect(j(b)).toMatch(ID_RE);
      expect(j(b)).not.toMatch(/^\d{8}T\d{6}Z-ios-/);
    }
  });

  it('an edit-pr job passes with or without a title, and is never named like a sim', () => {
    const p = { branch: 'ios-probe-check', sha: 'a'.repeat(40), body: 'New body.' };
    for (const job of [makeEditPrJob(p, NOW), makeEditPrJob({ ...p, title: 'A new title' }, NOW)]) {
      expect(validateJob(job, job.id, NOW)).toBeNull();
      expect(job.id).toMatch(/^\d{8}T\d{6}Z-edit-ios-probe-check-[0-9a-f]{4}$/);
      expect(job.params.bodySha256).toBe(sha256('New body.'));
    }
    // An open-pr's params must carry a title; only edit-pr may leave it out.
    const noTitle = { ...makeEditPrJob(p, NOW), job: 'open-pr' };
    expect(validateJob(noTitle, noTitle.id, NOW)).toBe('BAD_PARAM');
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
