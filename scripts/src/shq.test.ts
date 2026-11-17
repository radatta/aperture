import { describe, expect, it } from 'vitest';
import { shq } from './shq.ts';

// A zsh word's value by its quoting rules for the shapes shq emits: bare [\w./-] text, '…' spans, and \' between
// them; anything else outside quotes throws, so nothing zsh would act on can pass.
function unquote(w: string): string {
  let out = '';
  for (let i = 0; i < w.length;) {
    if (w[i] === "'") {
      const close = w.indexOf("'", i + 1);
      if (close < 0) throw new Error(`unclosed quote in ${w}`);
      out += w.slice(i + 1, close);
      i = close + 1;
    } else if (w[i] === '\\') {
      if (w[i + 1] !== "'")
        throw new Error(`a backslash outside quotes before ${w[i + 1]} in ${w}`);
      out += "'";
      i += 2;
    } else {
      if (!/[\w./-]/.test(w[i]!)) throw new Error(`unquoted ${w[i]} in ${w}`);
      out += w[i++];
    }
  }
  return out;
}

const HOSTILE = [
  'a;b',
  'a$(touch x)b',
  'a`id`b',
  "it's",
  "''",
  'say "hi"',
  'two words',
  'wow!',
  'glob*',
  'what?',
  '[x]',
  'a\\b',
  '~/x',
  "mix 'of' $all; `the` !rest*?[",
  '',
];

describe('shq', () => {
  it.each(HOSTILE)('quotes %j so zsh reads it back unchanged', (s) => {
    const q = shq(s);
    expect(q.startsWith("'")).toBe(true);
    expect(unquote(q)).toBe(s);
  });

  it('plain words stay bare', () => {
    for (const s of ['lanes-tidy', 'localNotes/pr-lanes-tidy.md', 'a_b.c', 'v1.2'])
      expect(shq(s)).toBe(s);
  });
});
