import { describe, it, expect } from 'vitest';

// iOS Safari zooms the page into any input, textarea or select under 16px the moment it's focused, and
// stays zoomed (CONVENTIONS → "Text fields are 16px or larger"; seen on-device 2026-10-29, PR 66). Headless
// Chromium never zooms, so only this scan catches the next one. It reads the tag's own className literal —
// a string or a {…} expression — never its text or a comment (LedgerControls names text-sm in one).
const FIELD_TAG = /<(?:input|select|textarea)\b/g;
const SMALL = /\btext-(?:sm|xs)\b/;

// The index just past the tag's `>` — walked, not matched: an attribute may hold a `>` (an arrow function)
// or a `}` (inside a string), so strings and brace depth are tracked.
function tagEnd(src: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i + 1;
  }
  return src.length;
}

// The tag's className value — the whole string or {…} expression, so a template or a cx() call counts too.
function classNameOf(tag: string): { value: string; at: number } | null {
  const m = /\bclassName=/.exec(tag);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < tag.length; i++) {
    const c = tag[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) {
        quote = null;
        if (depth === 0) return { value: tag.slice(start, i + 1), at: start };
      }
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { value: tag.slice(start, i + 1), at: start };
  }
  return { value: tag.slice(start), at: start };
}

// A comment inside the {…} is prose, not a class (LedgerControls' SearchBox says why it has no text-sm).
const uncommented = (expr: string) => expr.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

export function smallFields(sources: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, src] of Object.entries(sources))
    for (const m of src.matchAll(FIELD_TAG)) {
      const tag = src.slice(m.index, tagEnd(src, m.index));
      const cls = classNameOf(tag);
      if (cls && SMALL.test(uncommented(cls.value)))
        out.push(`${path}:${src.slice(0, m.index + cls.at).split('\n').length}`);
    }
  return out;
}

describe('text fields are 16px or larger', () => {
  it('no field under 16px', () => {
    const sources = import.meta.glob<string>(['../**/*.tsx', '!../**/*.test.*'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(smallFields(sources)).toEqual([]);
  });

  it('reads the tag’s className, not its neighbours', () => {
    expect(
      smallFields({
        'a.tsx': '<input\n  value={v}\n  className="px-2 text-sm text-ink"\n/>',
        'b.tsx': "<select className={cx('text-xs', open && 'ring')} />",
        'c.tsx': '<textarea className={`rounded ${big ? "text-lg" : "text-sm"}`} />',
        // text-sm on the label and in a comment, not on the field
        'd.tsx':
          '<label className="text-sm">{/* no text-sm here */}<input className="text-ink" /></label>',
        'e.tsx': '<Field className="text-sm" />', // a component, not a tag (Field itself is checked above)
        // a `>` inside an attribute, then a comment inside the className expression
        'f.tsx':
          '<input\n  onKeyDown={(e) => e.key === "Enter" && go()}\n  className={cx(\n    // no text-sm: iOS zooms\n    "text-ink",\n  )}\n/>',
        'g.tsx': '<input onKeyDown={(e) => go()} className="text-sm" />',
      }),
    ).toEqual(['a.tsx:3', 'b.tsx:1', 'c.tsx:1', 'g.tsx:1']);
  });
});
