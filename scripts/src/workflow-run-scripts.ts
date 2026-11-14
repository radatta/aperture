// No expression inside a `run:` script — why: INFRA §9 → Public repo. A blanket rule, no allowlist of safe contexts:
// there is nothing to judge. GitHub interpolates a shell comment too, so a script's comment lines count.
//
// Like workflow-fork-guard.ts, a narrow reader for our own layout, not a YAML parser: a shape it can't read throws.

export type RunScript = { line: number; script: string };

const KEY = /^(\s*)(-\s+)?run:(?:\s+(.*?))?\s*$/;
// A quoted or spaced key, a flow mapping (`- { run: … }`): shapes this reader can't follow, so it throws, never skips.
const LOOSE =
  /^\s*(?:-\s+)?(?:['"]run['"]\s*:|run\s+:|run:\S)|^\s*(?:-\s+)?(?:[\w-]+\s*:\s*)?[[\s]*\{[^#]*\brun['"]?\s*:/;
// `|` or `>`, with an optional chomping and indentation indicator in either order, and a trailing comment.
const BLOCK = /^[|>](?:[+-]?[1-9]?|[1-9][+-])(?:\s+#.*)?$/;
const indent = (l: string) => l.length - l.trimStart().length;

// Every `run:` script in a workflow or action file, with its 1-based line.
export function runScripts(text: string, file = 'workflow'): RunScript[] {
  const lines = text.split('\n');
  const out: RunScript[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!/^\s*#/.test(l) && LOOSE.test(l))
      throw new Error(`${file}:${i + 1}: unreadable run key — write a plain \`run:\``);
    const m = KEY.exec(l);
    if (!m) continue;
    const value = m[3] ?? '';
    const col = m[1]!.length + (m[2]?.length ?? 0); // the key's own column
    if (!value) throw new Error(`${file}:${i + 1}: empty run value — use a block (run: |)`);
    // An alias, anchor or tag: the script lives elsewhere, or isn't what this line says.
    if (/^[*&!]/.test(value))
      throw new Error(`${file}:${i + 1}: run value "${value}" — write the script inline`);
    if (/^[|>]/.test(value) && !BLOCK.test(value))
      throw new Error(`${file}:${i + 1}: unreadable block header "${value}"`);
    if (!BLOCK.test(value)) {
      // A plain or quoted value that runs on into more-indented lines would be read as its first line only.
      const next = lines.slice(i + 1).find((n) => n.trim());
      if (next !== undefined && indent(next) > col)
        throw new Error(`${file}:${i + 1}: multi-line run value — use a block (run: |)`);
      out.push({ line: i + 1, script: value });
      continue;
    }
    // The body: every following line indented past the key's column (blank lines included).
    const body: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim() && indent(next) <= col) break;
      body.push(next);
      i++;
    }
    out.push({ line: i - body.length + 2, script: body.join('\n') }); // the body's first line
  }
  return out;
}

// `files` maps a repo-relative path to its text.
export function checkRunExpressions(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [f, text] of Object.entries(files))
    for (const { line, script } of runScripts(text, f))
      script.split('\n').forEach((l, j) => {
        if (l.includes('${{'))
          problems.push(`${f}:${line + j}: expression in a run script — pass it through env:`);
      });
  return problems;
}
