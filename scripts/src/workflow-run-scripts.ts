// No expression inside a `run:` script (INFRA §9 → Public repo). GitHub splices `${{ … }}` into the script text before
// the shell parses it, so an input or event value holding a quote or `$(…)` becomes code. Every value reaches a script
// through `env:` and a quoted "$VAR" instead. A blanket rule, no allowlist of safe contexts: there is nothing to judge.
// GitHub interpolates a shell comment too, so a script's comment lines count.
//
// Like workflow-fork-guard.ts, a narrow reader for our own layout, not a YAML parser: a shape it can't read throws.

export type RunScript = { line: number; script: string };

const KEY = /^(\s*)(-\s+)?run:(?:\s+(.*?))?\s*$/;
const LOOSE = /^\s*(?:-\s+)?(?:['"]run['"]\s*:|run\s+:|run:\S)/;
const BLOCK = /^[|>][+-]?$/;

// Every `run:` script in a workflow or action file, with its 1-based line.
export function runScripts(text: string, file = 'workflow'): RunScript[] {
  const lines = text.split('\n');
  const out: RunScript[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (LOOSE.test(l))
      throw new Error(`${file}:${i + 1}: unreadable run key — write a plain \`run:\``);
    const m = KEY.exec(l);
    if (!m) continue;
    const value = m[3] ?? '';
    if (value && !BLOCK.test(value)) {
      if (/^['"]/.test(value) && !/['"]$/.test(value))
        throw new Error(`${file}:${i + 1}: multi-line quoted run value — use a block (run: |)`);
      out.push({ line: i + 1, script: value });
      continue;
    }
    if (!value) throw new Error(`${file}:${i + 1}: empty run value — use a block (run: |)`);
    // The body: every following line indented past the key's own column (blank lines included).
    const col = m[1]!.length + (m[2]?.length ?? 0);
    const body: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim() && next.length - next.trimStart().length <= col) break;
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
