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

// The section's first table: header, separator, rows (until the first non-table line).
function table(s: Section): Table | undefined {
  const i = s.body.findIndex((b) => b.text.trimStart().startsWith('|'));
  if (i < 0) return undefined;
  const rows: Table['rows'] = [];
  const header = cells(s.body[i]!.text);
  for (let j = i + 1; j < s.body.length; j++) {
    const b = s.body[j]!;
    if (!b.text.trimStart().startsWith('|')) break;
    if (j === i + 1 && /^\|?\s*:?-{3,}/.test(b.text.trim())) continue;
    rows.push({ line: b.line, cells: cells(b.text) });
  }
  return { header, rows };
}

const col = (t: Table, re: RegExp) => t.header.findIndex((h) => re.test(h));
const isNone = (s: Section) => /^none\b/i.test(s.body[0]?.text.trim() ?? '') && !table(s);
const stripCode = (s: string) => s.replace(/`([^`]*)`/g, '$1');

// `git grep … → 9; grep -rn … → 0`: each search with its hit count.
export interface Search {
  command: string;
  hits: number | undefined;
}
export function searches(cell: string): Search[] {
  return cell
    .split(/;\s*(?=`?(?:git grep|grep|rg)\b)/)
    .map((seg) => {
      const m = /^`?([^`]*?)`?\s*(?:→|->)\s*(\d+)\b/.exec(seg.trim());
      return m
        ? { command: m[1]!.trim(), hits: Number(m[2]) }
        : { command: stripCode(seg).trim(), hits: undefined };
    })
    .filter((s) => s.command);
}

// The repo paths a search command names: tokens that aren't flags or patterns and start with a top-level entry.
function scopedPaths(command: string, tree: Tree): string[] {
  const toks = command.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''));
  const out: string[] = [];
  let skip = false;
  for (let i = toks[0] === 'git' ? 2 : 1; i < toks.length; i++) {
    const t = toks[i]!;
    if (skip) {
      skip = false;
      continue;
    }
    if (/^-(e|f|-regexp|-file)$/.test(t)) skip = true;
    if (t.startsWith('-')) continue;
    const first = t.replace(/^\.\//, '').split('/')[0]!;
    if (tree.topLevel.has(first)) out.push(t);
  }
  return out;
}

const ROOT_WIDE = /(^|\s)(\.|\.\/|\/workspace\/?|\*)(\s|$)/;

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
  const tok = token.replace(/#.*$/, '').replace(/[.,;]$/, '');
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

const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX)\b|\?\?\?|\bto be (decided|determined)\b/i;

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
  const checkRefs = (line: number, check: string, cell: string, what: string) => {
    const rs = refs(cell);
    if (!rs.length)
      return (add(line, check, `${what}: no row id (C1, U1, I1, O1, P1 or T1)`), false);
    for (const r of rs) if (!ids.has(r)) add(line, 'ref', `${r} is not a row in this plan`);
    return true;
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
          if (!/\S+:\d+/.test(v) && !/^(none|n\/a)\b/i.test(v))
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
          if (!/^(git grep|grep|rg)\b/.test(s.command))
            add(
              r.line,
              'census',
              `not a search: "${s.command.slice(0, 40)}" (git grep, grep or rg)`,
            );
          else if (s.hits === undefined)
            add(r.line, 'census', `no hit count after "${s.command.slice(0, 40)}"`);
          else if (/\s\|\s/.test(s.command))
            add(
              r.line,
              'census',
              'a pipe in a search hides its count: one command, one -e per form',
            );
          else if (/\s(;|&&|\|\|)\s|;\s|\$\(|`/.test(s.command))
            add(r.line, 'census', 'one command per search: no ;, &&, || or $(…)');
          else if (ROOT_WIDE.test(s.command))
            add(r.line, 'census', 'a search of the whole root: name the directories');
          else if (!scopedPaths(s.command, tree).length)
            add(r.line, 'census', `no repo directory named in "${s.command.slice(0, 40)}"`);
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
        if (/^searched:/i.test(e)) {
          if (!/https?:\/\/\S+/.test(e)) bad('searched: needs the URL it came from');
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
      if (!r.cells.some((c) => /fails when:\s*\S.{2,}/i.test(c)))
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
      const last = r.cells[r.cells.length - 1] ?? '';
      if (/\.test\.tsx?\b/.test(last)) continue; // a named test file is a pointer too
      checkRefs(r.line, 'invariant', last, 'Failing test');
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
        checkRefs(r.line, 'premortem', r.cells[r.cells.length - 1] ?? '', 'Covered by');
    }
  }

  const steps = need('Step plan');
  if (steps)
    for (const r of steps.rows) {
      if (!r.cells.some((c) => /^\d+\s*[–-]\s*\d+\??$/.test(c)))
        add(r.line, 'steps', 'no `<lo>–<hi>` minutes');
      if (!r.cells[r.cells.length - 1])
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
    const prose = l.replace(/`[^`]*`/g, '``');
    if (PLACEHOLDER.test(prose))
      add(i + 1, 'placeholder', `"${PLACEHOLDER.exec(prose)![0]}" left in`);
    if (l.trimStart().startsWith('|') && cells(l).some((c) => /^<[^<>]+>$/.test(c)))
      add(i + 1, 'placeholder', 'a cell that is only a `<…>` placeholder');
    for (const p of pathClaims(l, tree)) {
      if (added.has(p.path)) continue;
      if (!tree.exists(p.path))
        add(
          i + 1,
          'path',
          `\`${p.token}\` does not exist (a file the change adds: \`path\` (new))`,
        );
      else if (p.from !== undefined) {
        const n = tree.lineCount(p.path);
        const last = p.to ?? p.from;
        if (n === undefined) add(i + 1, 'path', `\`${p.token}\`: not a readable file`);
        else if (p.from < 1 || last > n || (p.to !== undefined && p.to < p.from))
          add(i + 1, 'path', `\`${p.token}\`: ${p.path} has ${n} lines`);
      }
    }
  });

  problems.sort((a, b) => a.line - b.line || a.check.localeCompare(b.check));
  return { mode, problems };
}
