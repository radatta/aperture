import { describe, expect, it } from 'vitest';
import { parseInline, parseNotes, safeHref } from './parseNotes';

const text = (t: string) => ({ kind: 'text', text: t });

describe('parseNotes blocks', () => {
  it('splits paragraphs on blank lines and keeps single newlines as lines', () => {
    expect(parseNotes('one\ntwo\n\nthree')).toEqual([
      { kind: 'p', lines: [[text('one')], [text('two')]] },
      { kind: 'p', lines: [[text('three')]] },
    ]);
  });

  it('groups `- ` bullets and `1. ` numbered items, keeping the start number', () => {
    expect(parseNotes('- a\n- b\n\n3. c\n4. d')).toEqual([
      { kind: 'ul', items: [[text('a')], [text('b')]] },
      { kind: 'ol', start: 3, items: [[text('c')], [text('d')]] },
    ]);
  });

  it('starts a new block when the kind changes without a blank line', () => {
    expect(parseNotes('intro\n- a\nafter').map((b) => b.kind)).toEqual(['p', 'ul', 'p']);
  });

  it('treats CRLF like LF and ignores leading/trailing blank lines', () => {
    expect(parseNotes('\r\n a\r\nb \r\n\r\n')).toEqual([
      { kind: 'p', lines: [[text('a')], [text('b')]] },
    ]);
  });

  it('leaves unsupported syntax as literal text', () => {
    for (const src of ['# heading', '> quote', '![img](https://x.io/a.png)', '* star bullet']) {
      const [block] = parseNotes(src);
      expect(block?.kind).toBe('p');
    }
    expect(parseNotes('# heading')).toEqual([{ kind: 'p', lines: [[text('# heading')]] }]);
  });
});

describe('parseInline', () => {
  it('parses bold, italic, and code', () => {
    expect(parseInline('**b** *i* _j_ `c`')).toEqual([
      { kind: 'strong', children: [text('b')] },
      text(' '),
      { kind: 'em', children: [text('i')] },
      text(' '),
      { kind: 'em', children: [text('j')] },
      text(' '),
      { kind: 'code', text: 'c' },
    ]);
  });

  it('nests emphasis inside bold', () => {
    expect(parseInline('**a *b***')).toEqual([
      { kind: 'strong', children: [text('a '), { kind: 'em', children: [text('b')] }] },
    ]);
  });

  it('keeps unmatched and spaced markers literal', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(parseInline('** not bold **')).toEqual([text('** not bold **')]);
    expect(parseInline('a `lone tick')).toEqual([text('a `lone tick')]);
    expect(parseInline('``')).toEqual([text('``')]);
  });

  it('never italicizes snake_case', () => {
    expect(parseInline('use snake_case_name here')).toEqual([text('use snake_case_name here')]);
  });

  it('does not parse markup inside code', () => {
    expect(parseInline('`**x** [a](https://x.io)`')).toEqual([
      { kind: 'code', text: '**x** [a](https://x.io)' },
    ]);
  });

  it('links [text](url) for http, https, and mailto', () => {
    expect(parseInline('[pset](https://example.edu/p4)')).toEqual([
      { kind: 'link', href: 'https://example.edu/p4', text: 'pset' },
    ]);
    expect(parseInline('[me](mailto:a@b.co)')).toEqual([
      { kind: 'link', href: 'mailto:a@b.co', text: 'me' },
    ]);
  });

  it('autolinks bare URLs and drops trailing punctuation', () => {
    expect(parseInline('see https://x.io/a.')).toEqual([
      text('see '),
      { kind: 'link', href: 'https://x.io/a', text: 'https://x.io/a' },
      text('.'),
    ]);
    expect(parseInline('(https://x.io/a)')).toEqual([
      text('('),
      { kind: 'link', href: 'https://x.io/a', text: 'https://x.io/a' },
      text(')'),
    ]);
    expect(parseInline('https://en.wikipedia.org/wiki/Foo_(bar)')[0]).toEqual({
      kind: 'link',
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('does not autolink a URL glued to a word', () => {
    expect(parseInline('xhttps://x.io')).toEqual([text('xhttps://x.io')]);
  });
});

describe('link safety', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:msgbox(1)',
    '/relative/path',
    'relative',
    '//evil.example',
  ])('rejects %j', (href) => {
    expect(safeHref(href)).toBeNull();
  });

  it('renders an unsafe or relative link as its literal source', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([text('[x](javascript:alert(1))')]);
    expect(parseInline('[x](JAVASCRIPT:alert`1`)')).toEqual([text('[x](JAVASCRIPT:alert`1`)')]);
    expect(parseInline('[x](data:text/html,hi)')).toEqual([text('[x](data:text/html,hi)')]);
    expect(parseInline('[x](/local)')).toEqual([text('[x](/local)')]);
  });

  it('keeps HTML and entities as plain text', () => {
    expect(parseInline('<script>alert(1)</script> &lt;b&gt;')).toEqual([
      text('<script>alert(1)</script> &lt;b&gt;'),
    ]);
  });
});
