import { describe, expect, it } from 'vitest';
import { fakeRun } from './fakes.ts';
import { iosFiles } from './ios-routing.ts';

const diff = (...files: string[]) => fakeRun([['git diff', files.join('\n')]]);

describe('iosFiles', () => {
  it("keeps the files only slot A's Simulator proves: the app's iOS surface, the sim harness, the probe job", () => {
    const { run, calls } = diff(
      'app/src/modules/capture/CaptureBar.tsx',
      'app/pwa/manifest.webmanifest',
      'tools/mailroom/jobs/sim.sh',
      'scripts/src/devcheck/probe-only.ts',
      'docs/x.md',
    );
    expect(iosFiles(run)).toEqual([
      'app/src/modules/capture/CaptureBar.tsx',
      'app/pwa/manifest.webmanifest',
      'tools/mailroom/jobs/sim.sh',
      'scripts/src/devcheck/probe-only.ts',
    ]);
    expect(calls[0]?.args).toEqual(['diff', '--name-only', '--no-renames', 'origin/main...HEAD']);
  });

  it('is empty for a branch nothing iOS can see', () => {
    expect(iosFiles(diff('app/src/pages/Home/index.tsx', 'lambdas/src/backend.ts').run)).toEqual(
      [],
    );
    expect(iosFiles(diff().run)).toEqual([]);
  });

  it('says to fetch main when the diff fails, never routes blind', () => {
    const { run } = fakeRun([
      [
        'git diff',
        () => {
          throw new Error('git diff failed: unknown revision');
        },
      ],
    ]);
    expect(() => iosFiles(run)).toThrow(/git fetch origin main/);
  });
});
