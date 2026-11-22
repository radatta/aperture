// @aperture/scripts — plan-lint's checks (docs/ops/PLAN.md): a lane's plan against the template's shape. Pure: the
// caller passes what the file system knows (`Tree`); nothing here reads a file, spawns or runs a census command.
// Plain `node`: erasable syntax, no imports.

export type Mode = 'full' | 'light';

export interface Problem {
  line: number; // 1-based
  check: string;
  message: string;
}

// What plan-lint may know about the repo: whether a path exists and how many lines a file has.
export interface Tree {
  topLevel: ReadonlySet<string>; // the root's own entries: a token is a path claim only if it starts with one
  exists(path: string): boolean;
  lineCount(path: string): number | undefined; // undefined for a directory or an unreadable file
  root?: string; // absolute root: an absolute path under it is checked relative to it
}

export const SECTIONS_FULL = [
  'Operator steps',
  'Files',
  'Change census',
  'Unknowns',
  'Invariants',
  'Ordering and races',
  'Pre-mortem',
  'Test matrix',
  'Step plan',
  'Open questions',
] as const;
export const LIGHT_DROPS = ['Ordering and races', 'Pre-mortem'] as const;
export const SECTIONS_LIGHT = SECTIONS_FULL.filter(
  (s) => !(LIGHT_DROPS as readonly string[]).includes(s),
);
export const CLASSES = [
  'reader/writer',
  'outside tool',
  'race',
  'contract',
  'test cannot fail',
  'other',
] as const;
export const EVIDENCE = ['searched:', 'probed:', 'run-only:'] as const;
export const LIGHT_MAX_FILES = 5;
export const INVARIANTS = { full: [3, 7], light: [1, 3] } as const;
export const PREMORTEM_MIN = 6;
// Sections whose whole body may be `none` (with an optional reason after it).
const MAY_BE_NONE = new Set(['Operator steps', 'Unknowns', 'Open questions']);

interface Table {
  header: string[];
  rows: { line: number; cells: string[] }[];
}

interface Section {
  name: string;
  line: number;
  body: { line: number; text: string }[]; // fenced lines dropped
}

// Split a table row on pipes not escaped with a backslash; `\|` stays a literal pipe in the cell.
export function cells(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  const s = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

// Lines inside ``` or ~~~ fences (the fence lines too) are blanked: a quoted example is not the plan.
export function unfence(lines: string[]): string[] {
  let fence: string | undefined;
  return lines.map((l) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = undefined;
      return '';
    }
    if (m) return ((fence = m[1]!), '');
    return l;
  });
}

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((l, i) => {
    const m = /^## (.+?)\s*$/.exec(l);
    if (m) out.push({ name: m[1]!, line: i + 1, body: [] });
    else if (/^# /.test(l))
      out.push({ name: '', line: i + 1, body: [] }); // a new top heading ends a section
    else if (out.length && l.trim()) out[out.length - 1]!.body.push({ line: i + 1, text: l });
  });
  return out.filter((s) => s.name);
}

// The section's first table: header, separator, rows (until the first non-table, blank or fenced line).
function table(s: Section): Table | undefined {
  const i = s.body.findIndex((b) => b.text.trimStart().startsWith('|'));
  if (i < 0) return undefined;
  const rows: Table['rows'] = [];
  const header = cells(s.body[i]!.text);
  for (let j = i + 1; j < s.body.length; j++) {
    const b = s.body[j]!;
    if (!b.text.trimStart().startsWith('|') || b.line !== s.body[j - 1]!.line + 1) break;
    if (j === i + 1 && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(b.text.trim())) continue;
    rows.push({ line: b.line, cells: cells(b.text) });
  }
  return { header, rows };
}

const col = (t: Table, re: RegExp) => t.header.findIndex((h) => re.test(h));
const stripCode = (s: string) => s.replace(/`([^`]*)`/g, '$1');
const isNone = (s: Section) =>
  /^none\b/i.test(stripCode(s.body[0]?.text.trim() ?? '')) && !table(s);

// `git grep … → 9; git grep … → 0`: each search with its hit count. The cell splits on every `;` outside backticks,
// and each piece must be one whole search, `` `cmd` → n `` and at most a bracketed note: text after a count is never
// dropped unread, since the reviewer re-runs what the cell shows.
export interface Search {
  command: string;
  hits: number | undefined;
  rest?: string;
}
export function searches(cell: string): Search[] {
  const pieces: string[] = [];
  let cur = '';
  let code = false;
  for (const ch of cell) {
    if (ch === '`') code = !code;
    if (ch === ';' && !code) {
      pieces.push(cur);
      cur = '';
    } else cur += ch;
  }
  pieces.push(cur);
  return pieces
    .map((seg) => {
      const m = /^`?([^`]*?)`?\s*(?:→|->)\s*(\d+)\b(.*)$/s.exec(seg.trim());
      if (!m) return { command: stripCode(seg).trim(), hits: undefined };
      const rest = m[3]!.trim();
      const s: Search = { command: m[1]!.trim(), hits: Number(m[2]) };
      return rest && !/^\([^`()]*\)$/.test(rest) ? { ...s, rest } : s;
    })
    .filter((s) => s.command);
}

// A census search is re-run by the plan reviewer, so it is held to an allowlist, never a denylist: one `git grep`
// (tracked files, plus untracked non-ignored ones with --untracked; never an ignored file, whatever path is named),
// flags from this list (each probed on git 2.55), and operands that are plain repo paths. Anything else is refused.
// Not rg: a `-g` glob or an ignored path named outright makes it read ignored files.
export const SEARCH_FLAGS = {
  bare: 'nilLwFEPcIhHov',
  value: 'eABCm',
  long: [
    'count',
    'line-number',
    'ignore-case',
    'word-regexp',
    'fixed-strings',
    'extended-regexp',
    'perl-regexp',
    'files-with-matches',
    'files-without-match',
    'invert-match',
    'only-matching',
    'untracked',
  ],
  longValue: ['after-context', 'before-context', 'context', 'max-count'],
} as const;
const NUMERIC = new Set([
  'A',
  'B',
  'C',
  'm',
  'after-context',
  'before-context',
  'context',
  'max-count',
]);

// A command's words as the shell would split them, or why it isn't one plain command. Single quotes are literal;
// double quotes only around text with nothing the shell expands.
export function shellWords(command: string): string[] | string {
  const out: string[] = [];
  let cur: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return 'an unclosed quote';
      const inner = command.slice(i + 1, end);
      if (ch === '"' && /[$`\\!]/.test(inner))
        return 'a $, `, \\ or ! inside double quotes: use single quotes';
      cur = (cur ?? '') + inner;
      i = end;
    } else if (/\s/.test(ch)) {
      if (cur !== undefined) out.push(cur);
      cur = undefined;
    } else if (ch === '|')
      return 'a pipe in a search hides its count: one command, one -e per form';
    else if (/[;&<>()$`\\*?[\]{}~#!]/.test(ch))
      return `shell syntax outside quotes (${ch}): one plain command, the pattern in single quotes`;
    else cur = (cur ?? '') + ch;
  }
  if (cur !== undefined) out.push(cur);
  return out;
}

const PLAIN_PATH = /^[A-Za-z0-9_.\-/@+]+$/;
// Why an operand isn't a plain repo path in the checkout, or undefined when it is one.
export function pathProblem(op: string, tree: Tree): string | undefined {
  const segs = op.split('/').filter((s) => s && s !== '.');
  if (!segs.length) return 'a search of the whole root: name the directories';
  if (
    !PLAIN_PATH.test(op) ||
    op.startsWith('/') ||
    segs.includes('..') ||
    segs.includes('.secrets')
  )
    return `"${op}" is not a plain repo path (no leading /, .., ~, pathspec magic or .secrets)`;
  if (!tree.exists(segs.join('/'))) return `"${op}" is not in the checkout`;
  return undefined;
}

// Why a census search breaks the allowlist, or undefined when it is one plain, scoped search.
export function searchProblem(command: string, tree: Tree): string | undefined {
  const toks = shellWords(command);
  if (typeof toks === 'string') return toks;
  if (toks[0] !== 'git' || toks[1] !== 'grep')
    return `not a census search: "${command.slice(0, 40)}" (git grep)`;
  const f = SEARCH_FLAGS;
  const operands: string[] = [];
  let beforeDash = -1;
  let pattern = false;
  let rest = false;
  const value = (name: string, v: string | undefined) => {
    if (v === undefined) return `${name} needs a value`;
    if (NUMERIC.has(name) && !/^\d+$/.test(v)) return `${name} takes a number`;
    if (name === 'e') pattern = true;
    return undefined;
  };
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i]!;
    if (rest || !t.startsWith('-') || t === '-') {
      operands.push(t);
      continue;
    }
    if (t === '--') {
      rest = true;
      beforeDash = operands.length;
      continue;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if ((f.long as readonly string[]).includes(name) && eq < 0) continue;
      if (!(f.longValue as readonly string[]).includes(name))
        return `flag --${name} is not on the census list (docs/ops/PLAN.md → Change census)`;
      const why = value(name, eq < 0 ? toks[++i] : t.slice(eq + 1));
      if (why) return why;
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j]!;
      if (f.bare.includes(c)) continue;
      if (!f.value.includes(c))
        return `flag -${c} is not on the census list (docs/ops/PLAN.md → Change census)`;
      const why = value(c, j + 1 < t.length ? t.slice(j + 1) : toks[++i]);
      if (why) return why;
      break;
    }
  }
  // with no -e, the first operand before `--` is the pattern
  if (!pattern && !operands.length) return 'no pattern';
  // with `--`, git reads every other operand before it as a revision (another commit's files)
  if (beforeDash > (pattern ? 0 : 1))
    return `"${operands[pattern ? 0 : 1]}" before -- is a revision to git: put every path after --`;
  const paths = pattern ? operands : operands.slice(1);
  if (!paths.length) return `no repo path named in "${command.slice(0, 40)}"`;
  for (const p of paths) {
    const why = pathProblem(p, tree);
    if (why) return why;
  }
  return undefined;
}

const PATH_CHARS = /^[A-Za-z0-9_.\-/@+]+(:\d+(-\d+)?)?$/;

// Backticked tokens that claim a repo path. `(new)` right after the closing backtick marks a file the change adds;
// one mark anywhere exempts that path everywhere in the plan.
export interface PathClaim {
  token: string;
  path: string;
  isNew: boolean;
  from?: number;
  to?: number;
}
const relative = (token: string, tree: Tree) => {
  const tok = token
    .replace(/#.*$/, '')
    .replace(/[.,;]$/, '')
    .replace(/^(\.\/)+/, '')
    .replace(/:(\d+)–(\d+)$/, ':$1-$2');
  return tree.root && tok.startsWith(tree.root + '/') ? tok.slice(tree.root.length + 1) : tok;
};
export function pathClaims(line: string, tree: Tree): PathClaim[] {
  const out: PathClaim[] = [];
  for (const m of line.matchAll(/`([^`\s]+)`(\s*\(new\))?/g)) {
    const tok = relative(m[1]!, tree);
    if (!PATH_CHARS.test(tok) || tok.startsWith('/')) continue;
    const lm = /:(\d+)(?:-(\d+))?$/.exec(tok);
    const path = lm ? tok.slice(0, lm.index) : tok;
    const first = path.split('/')[0]!;
    if (!tree.topLevel.has(first) || first === 'localNotes' || first === 'node_modules') continue;
    out.push({
      token: m[1]!,
      path,
      isNew: !!m[2],
      from: lm ? Number(lm[1]) : undefined,
      to: lm?.[2] ? Number(lm[2]) : undefined,
    });
  }
  return out;
}

// The markers in capitals only ("todo apps" is product prose); quoted text is a mention, not a gap.
const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX)\b(?!\()|\?\?\?|\b[Tt]o be (decided|determined)\b/;

export function lint(text: string, tree: Tree): { mode?: Mode; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (line: number, check: string, message: string) =>
    problems.push({ line, check, message });
  const raw = text.split('\n');
  const lines = unfence(raw);

  // template: the mode line, right under the title.
  let mode: Mode | undefined;
  const ti = lines.slice(0, 10).findIndex((l) => /^Template:/i.test(l));
  if (ti < 0) add(1, 'template', 'no `Template: full|light — <why>` line under the title');
  else {
    const m = /^Template:\s*(full|light)\s*(?:—|-{1,2})\s*\S/.exec(lines[ti]!);
    if (m) mode = m[1] as Mode;
    else add(ti + 1, 'template', 'write `Template: full — <why>` or `Template: light — <why>`');
  }
  const want = mode === 'light' ? SECTIONS_LIGHT : SECTIONS_FULL;

  const secs = sections(lines);
  const byName = new Map<string, Section>();
  for (const s of secs) {
    if (!(SECTIONS_FULL as readonly string[]).includes(s.name)) continue; // appendices and extras are free
    if (byName.has(s.name)) add(s.line, 'section', `"${s.name}" appears twice`);
    else byName.set(s.name, s);
  }
  for (const name of want) if (!byName.has(name)) add(1, 'section', `missing "## ${name}"`);

  // ids every table defines, for pointer checks
  const ids = new Set<string>();
  for (const s of byName.values())
    for (const r of table(s)?.rows ?? []) {
      const id = r.cells[0] ?? '';
      const range = /^([A-Z])(\d+)\s*[–-]\s*\1?(\d+)$/.exec(id);
      if (range)
        for (let n = Number(range[2]); n <= Number(range[3]); n++) ids.add(`${range[1]}${n}`);
      else if (/^[A-Z]\d+$/.test(id)) ids.add(id);
    }
  const refs = (cell: string) => [...cell.matchAll(/\b([CUIOPT]\d+)\b/g)].map((m) => m[1]!);
  // `kinds`: the row letters this column may point at.
  const checkRefs = (line: number, check: string, cell: string, what: string, kinds: string) => {
    const rs = refs(cell);
    for (const r of rs)
      if (!kinds.includes(r[0]!))
        add(line, check, `${what}: ${r} is not a ${[...kinds].join('/')} row`);
      else if (!ids.has(r)) add(line, 'ref', `${r} is not a row in this plan`);
    if (!rs.length) {
      const list = [...kinds].map((k) => `${k}1`).join(', ');
      add(line, check, `${what}: no row id (${list.replace(/, (\w+)$/, ' or $1')})`);
    }
  };
  const cell = (t: Table, r: Table['rows'][number], re: RegExp) => {
    const c = col(t, re);
    return r.cells[c < 0 ? r.cells.length - 1 : c] ?? '';
  };

  // A section that is a table, or `none` where allowed.
  const need = (name: string): Table | undefined => {
    const s = byName.get(name);
    if (!s) return undefined;
    if (MAY_BE_NONE.has(name) && isNone(s)) return undefined;
    const t = table(s);
    if (!t || !t.rows.length)
      add(s.line, 'section', `"${name}" needs a table${MAY_BE_NONE.has(name) ? ' or `none`' : ''}`);
    return t?.rows.length ? t : undefined;
  };

  need('Operator steps');
  need('Open questions');

  const files = need('Files');
  if (files && mode === 'light' && files.rows.length > LIGHT_MAX_FILES)
    add(
      byName.get('Files')!.line,
      'template',
      `light allows at most ${LIGHT_MAX_FILES} files; this plan lists ${files.rows.length}`,
    );

  // census
  const census = need('Change census');
  if (census) {
    const cW = col(census, /^writers/i);
    const cR = col(census, /^readers/i);
    const cS = col(census, /^search/i);
    if (cW < 0 || cR < 0 || cS < 0)
      add(
        byName.get('Change census')!.line,
        'census',
        'columns must include Writers, Readers and Searches → hits',
      );
    else
      for (const r of census.rows) {
        for (const [c, what] of [
          [cW, 'Writers'],
          [cR, 'Readers'],
        ] as const) {
          const v = r.cells[c] ?? '';
          const claimed = pathClaims(v, tree).some((p) => p.from !== undefined);
          if (!claimed && !/^(none|n\/a)\b/i.test(stripCode(v)))
            add(r.line, 'census', `${what}: a \`path:line\` or \`none\``);
        }
        const ss = searches(r.cells[cS] ?? '');
        const counted = ss.filter((s) => s.hits !== undefined);
        const min = mode === 'light' ? 1 : 2;
        if (counted.length < min)
          add(
            r.line,
            'census',
            `${min} search${min > 1 ? 'es' : ''} with a hit count (\`<command>\` → <n>) needed, found ${counted.length}`,
          );
        for (const s of ss) {
          const why =
            s.hits === undefined
              ? `no hit count after "${s.command.slice(0, 40)}"`
              : s.rest !== undefined
                ? `text after the hit count of "${s.command.slice(0, 40)}": put each search in its own \`…\` → n, separated by ;`
                : searchProblem(s.command, tree);
          if (why) add(r.line, 'census', why);
        }
      }
  }

  // unknowns
  const unknowns = need('Unknowns');
  if (unknowns) {
    const cV = col(unknowns, /^version/i);
    const cE = col(unknowns, /^evidence/i);
    if (cV < 0 || cE < 0)
      add(byName.get('Unknowns')!.line, 'unknown', 'columns must include Version and Evidence');
    else
      for (const r of unknowns.rows) {
        if (!r.cells[cV]) add(r.line, 'unknown', 'Version is empty (write the version, or n/a)');
        const e = r.cells[cE] ?? '';
        const bad = (why: string) => add(r.line, 'unknown', why);
        // The rows go to plan-link-checker pasted inside an <unknowns> tag, so every cell is held to its rules.
        const row = r.cells.join(' | ');
        if (/[a-z][a-z0-9+.-]*:\/\/[^/\s]*:\d/i.test(row))
          bad('a URL with an explicit port (8080 pauses the container): link the public page');
        if (/<\s*\/?\s*unknowns\b/i.test(row))
          bad(
            'an <unknowns> tag in a row: it would end the tag the rows are pasted in for the link checker',
          );
        if (/^searched:/i.test(e)) {
          if (!/https:\/\/\S+/.test(e)) bad('searched: needs the https URL it came from');
          else if (/\bhttp:\/\//i.test(e))
            bad('searched: http is refused by the link checker: cite the https page');
        } else if (/^probed:/i.test(e)) {
          if (!/`[^`]+`\s*(?:→|->)\s*\S/.test(e)) bad('probed: needs `<command>` → <output>');
        } else if (/^run-only:/i.test(e)) {
          if (e.slice(9).trim().split(/\s+/).length < 3)
            bad('run-only: needs the reason no search or probe can settle it');
        } else if (/^open:/i.test(e)) bad('open: settle it (search or probe) before [kickoff]');
        else if (/from memory/i.test(e)) bad('"from memory" is not evidence: search or probe it');
        else bad(`evidence must start with ${EVIDENCE.join(', ')}`);
      }
  }

  // test matrix first: invariants point at it
  const matrix = need('Test matrix');
  if (matrix)
    for (const r of matrix.rows)
      if (
        !r.cells.some(
          (c) =>
            /fails when:\s*\S.{2,}/i.test(c) &&
            !/fails when:\s*(n\/a|never|nothing|none|-)(\W*$|\s*[(—–]|\s+-)/i.test(c),
        )
      )
        add(r.line, 'matrix', 'no `fails when: <mutation>`');

  const invariants = need('Invariants');
  if (invariants) {
    const [lo, hi] = INVARIANTS[mode ?? 'full'];
    const n = invariants.rows.length;
    if (n < lo || n > hi)
      add(
        byName.get('Invariants')!.line,
        'invariant',
        `${mode ?? 'full'} takes ${lo}–${hi} invariants, found ${n}`,
      );
    for (const r of invariants.rows) {
      const c = cell(invariants, r, /^failing/i);
      // a backticked test file is a pointer too
      if (pathClaims(c, tree).some((p) => /\.test\.[cm]?[jt]sx?$/.test(p.path)) && !refs(c).length)
        continue;
      checkRefs(r.line, 'invariant', c, 'Failing test', 'T');
    }
  }

  if (mode !== 'light') {
    const order = byName.get('Ordering and races');
    if (order) {
      const first = order.body[0]?.text.trim() ?? '';
      if (/^n\/a\b/i.test(first) && !table(order)) {
        if (
          first
            .replace(/^n\/a\s*(—|-{1,2}|:)?/i, '')
            .trim()
            .split(/\s+/)
            .filter(Boolean).length < 3
        )
          add(order.line, 'order', 'N/A needs a reason: `N/A — <why no write path or async hop>`');
      } else need('Ordering and races');
    }

    const pm = need('Pre-mortem');
    if (pm) {
      if (pm.rows.length < PREMORTEM_MIN)
        add(
          byName.get('Pre-mortem')!.line,
          'premortem',
          `at least ${PREMORTEM_MIN} reasons, found ${pm.rows.length}`,
        );
      const cC = col(pm, /^class/i);
      const seen = new Set(pm.rows.map((r) => (r.cells[cC] ?? '').toLowerCase()));
      for (const c of CLASSES)
        if (!seen.has(c)) add(byName.get('Pre-mortem')!.line, 'premortem', `no "${c}" row`);
      for (const r of pm.rows)
        checkRefs(r.line, 'premortem', cell(pm, r, /^covered/i), 'Covered by', 'CUIOT');
    }
  }

  const steps = need('Step plan');
  if (steps)
    for (const r of steps.rows) {
      const m = r.cells.map((c) => /^(\d+)\s*[–-]\s*(\d+)\??$/.exec(c)).find(Boolean);
      if (!m) add(r.line, 'steps', 'no `<lo>–<hi>` minutes');
      else if (Number(m[1]) > Number(m[2])) add(r.line, 'steps', `${m[0]}: low before high`);
      if (!cell(steps, r, /^from/i))
        add(r.line, 'steps', 'From is empty (the record it came from, or `no history`)');
    }

  // placeholders and paths, over every unfenced line
  const added = new Set(
    lines.flatMap((l) =>
      pathClaims(l, tree)
        .filter((p) => p.isNew)
        .map((p) => p.path),
    ),
  );
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const prose = l.replace(/`[^`]*`/g, '``').replace(/"[^"]*"/g, '""');
    if (PLACEHOLDER.test(prose))
      add(i + 1, 'placeholder', `"${PLACEHOLDER.exec(prose)![0]}" left in`);
    if (l.trimStart().startsWith('|') && cells(l).some((c) => /^<[^<>]+>$/.test(c)))
      add(i + 1, 'placeholder', 'a cell that is only a `<…>` placeholder');
    for (const p of pathClaims(l, tree)) {
      const segs = p.path.split('/');
      if (segs.includes('..') || segs.includes('.secrets'))
        add(i + 1, 'path', `\`${p.token}\`: not a plain repo path (no .. or .secrets)`);
      else if (p.isNew && tree.exists(p.path))
        add(
          i + 1,
          'path',
          `\`${p.token}\` (new) already exists: the plan misread the repo, or drop (new)`,
        );
      else if (added.has(p.path)) continue;
      else if (!tree.exists(p.path))
        add(
          i + 1,
          'path',
          `\`${p.token}\` does not exist (a file the change adds: \`path\` (new))`,
        );
      else if (p.from !== undefined) {
        const n = tree.lineCount(p.path);
        const last = p.to ?? p.from;
        if (n === undefined) add(i + 1, 'path', `\`${p.token}\`: not a readable file`);
        else if (p.from < 1 || last < p.from)
          add(i + 1, 'path', `\`${p.token}\`: not a line range (lines start at 1, low to high)`);
        else if (last > n) add(i + 1, 'path', `\`${p.token}\`: ${p.path} has ${n} lines`);
      }
    }
  });

  problems.sort((a, b) => a.line - b.line || a.check.localeCompare(b.check));
  return { mode, problems };
}
