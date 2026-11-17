import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTIFIERS_PATH, loadIdentifiers } from './identifiers.ts';

describe('loadIdentifiers', () => {
  const real = JSON.parse(readFileSync(IDENTIFIERS_PATH, 'utf8')) as {
    maintainer: Record<string, unknown>;
  };
  const write = (github: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'ids-')), 'identifiers.json');
    const maintainer = { ...real.maintainer, github };
    if (github === undefined) delete maintainer.github;
    writeFileSync(path, JSON.stringify({ ...real, maintainer }));
    return path;
  };

  it('loads the real config', () => {
    expect(loadIdentifiers(write(real.maintainer.github)).maintainer.github).toBe(
      real.maintainer.github,
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
    ['not a login', 'some one'],
    ['an email', 'someone@example.com'],
    ['over 39 characters', 'a'.repeat(40)],
  ])('refuses a maintainer.github that is %s, saying so', (_, github) => {
    expect(() => loadIdentifiers(write(github))).toThrow(
      /maintainer\.github must be a GitHub login/,
    );
  });
});
