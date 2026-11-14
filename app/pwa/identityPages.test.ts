import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTITY_PAGES, fillPage, pageValues } from './identityPages';

const ids = { maintainer: { name: 'Ada <Lovelace> & Co' }, email: { contact: 'ada@example.com' } };

describe('identity pages', () => {
  it('fills every token, HTML-escaped', () => {
    expect(fillPage('<p>{{maintainer.name}} · {{ email.contact }}</p>', pageValues(ids))).toBe(
      '<p>Ada &lt;Lovelace&gt; &amp; Co · ada@example.com</p>',
    );
  });

  it('refuses an unknown token rather than shipping it', () => {
    expect(() => fillPage('{{maintainer.email}}', pageValues(ids))).toThrow(/unknown token/);
  });

  it.each(IDENTITY_PAGES)('%s fills completely from the real templates', (page) => {
    const out = fillPage(
      readFileSync(join(import.meta.dirname, '../pages', page), 'utf8'),
      pageValues(ids),
    );
    expect(out).not.toMatch(/\{\{|\}\}/);
    expect(out).toContain('Ada &lt;Lovelace&gt; &amp; Co');
    expect(out).toContain('mailto:ada@example.com');
  });
});
