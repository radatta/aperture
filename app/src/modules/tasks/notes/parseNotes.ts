// Task notes, light markdown. A deliberately small subset, parsed here and rendered as React elements —
// never HTML, so nothing in a note can inject markup; the one live surface is `href`, which only ever
// carries an allowlisted http/https/mailto URL (anything else stays literal text).
//   blocks: paragraphs (blank line), single newline = <br>, `- ` bullets, `1. ` numbered
//   inline: **bold**, *italic* / _italic_, `code`, [text](url), bare http(s) URLs
// Not supported, by design: headings, images, raw HTML, blockquotes, tables, nesting, code fences.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; text: string };

export type Block =
  | { kind: 'p'; lines: Inline[][] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; start: number; items: Inline[][] };

// What the server will store for a draft: the normalization every writer applies (normalizeNotes),
// minus the cap check — the form compares and counts against this.
export const notesValue = (raw: string) => raw.replace(/\r\n?/g, '\n').trim();

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// The allowlist. Absolute URLs only — a relative link has no base here, so it fails to parse and stays
// text. The URL parser lowercases the scheme and strips tabs/newlines, so mixed-case and split schemes
// (`JavaScript:`, `java\tscript:`) resolve to their real protocol and are rejected.
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const BULLET = /^\s*- +(.*)$/;
const NUMBERED = /^\s*(\d{1,9})\. +(.*)$/;
// Sticky, so each is tried at one position of the line without slicing off the rest of it.
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/y;
const BARE_URL = /https?:\/\/[^\s<>]+/y;
const WORD = /[\p{L}\p{N}]/u;

const matchAt = (re: RegExp, s: string, i: number) => {
  re.lastIndex = i;
  return re.exec(s);
};

// Bare URLs end before trailing sentence punctuation (or the `*` closing emphasis around them), and
// before a `)` that closes an outer paren. Parens are counted once, so this stays linear.
function trimUrl(url: string): string {
  let open = 0;
  let close = 0;
  for (const ch of url) {
    if (ch === '(') open++;
    else if (ch === ')') close++;
  }
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1]!;
    if ('.,;:!?\'"*'.includes(c)) end--;
    else if (c === ')' && open < close) {
      end--;
      close--;
    } else break;
  }
  return url.slice(0, end);
}

// `*` / `_` emphasis: the closer must follow a non-space. `_` also must sit on word boundaries, so
// snake_case_names never italicize.
function findEmphasisClose(s: string, from: number, mark: string): number {
  for (let j = from + 1; j < s.length; j++) {
    if (s[j] !== mark) continue;
    if (mark === '*' && s[j + 1] === '*') {
      j++;
      continue;
    }
    if (/\s/.test(s[j - 1]!)) continue;
    if (mark === '_' && WORD.test(s[j + 1] ?? '')) continue;
    return j;
  }
  return -1;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const prev = s[i - 1] ?? '';

    if (c === '`') {
      const close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        out.push({ kind: 'code', text: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (c === '[') {
      const m = matchAt(LINK, s, i);
      if (m) {
        const href = safeHref(m[2]!);
        if (href) {
          flush();
          out.push({ kind: 'link', href, text: m[1]! });
        } else buf += m[0]; // unsafe or relative → the literal source, not a link
        i += m[0].length;
        continue;
      }
    }

    if (c === 'h' && !WORD.test(prev) && prev !== '/') {
      const m = matchAt(BARE_URL, s, i);
      const url = m ? trimUrl(m[0]) : '';
      if (url) {
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ kind: 'link', href, text: url });
        } else buf += url; // unparseable (e.g. `http://[`) → text, and never re-scanned
        i += url.length;
        continue;
      }
    }

    if (c === '*' && s[i + 1] === '*' && s[i + 2] && !/\s/.test(s[i + 2]!)) {
      let close = s.indexOf('**', i + 2);
      while (close !== -1 && s[close + 2] === '*') close++; // `***` closes em inside, then bold
      if (close > i + 2 && !/\s/.test(s[close - 1]!)) {
        flush();
        out.push({ kind: 'strong', children: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    const single = (c === '*' && s[i + 1] !== '*') || (c === '_' && !WORD.test(prev));
    if (single && s[i + 1] && !/\s/.test(s[i + 1]!)) {
      const close = findEmphasisClose(s, i, c);
      if (close > i + 1) {
        flush();
        out.push({ kind: 'em', children: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

export function parseNotes(src: string): Block[] {
  const blocks: Block[] = [];
  let open = false; // the last block still takes lines — no blank line since it started
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      open = false;
      continue;
    }
    const prev = open ? blocks[blocks.length - 1] : undefined;
    const bullet = BULLET.exec(line);
    // Mid-paragraph, only `1.` starts a list, so a line like "2026. was a good year" stays prose.
    const n = bullet ? null : NUMBERED.exec(line);
    const numbered = n && (prev?.kind !== 'p' || n[1] === '1') ? n : null;
    if (bullet) {
      const item = parseInline(bullet[1]!);
      if (prev?.kind === 'ul') prev.items.push(item);
      else blocks.push({ kind: 'ul', items: [item] });
    } else if (numbered) {
      const item = parseInline(numbered[2]!);
      if (prev?.kind === 'ol') prev.items.push(item);
      else blocks.push({ kind: 'ol', start: Number(numbered[1]), items: [item] });
    } else {
      const text = parseInline(line.trim());
      if (prev?.kind === 'p') prev.lines.push(text);
      else blocks.push({ kind: 'p', lines: [text] });
    }
    open = true;
  }
  return blocks;
}

// The note as one line of plain text — markers dropped, lines and items joined by a space — for a
// truncated one-line preview (the night review's reflection line).
export function notesPlainText(src: string): string {
  const inline = (xs: Inline[]): string =>
    xs.map((x) => ('children' in x ? inline(x.children) : x.text)).join('');
  return parseNotes(src)
    .flatMap((b) => (b.kind === 'p' ? b.lines : b.items))
    .map(inline)
    .join(' ');
}
