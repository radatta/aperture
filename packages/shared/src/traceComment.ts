// Trace detection from the code itself (docs/areas/recruiting/index.md → Coach events): in an interview the user
// writes the trace as a comment above the code, so a snapshot taken before the first Run or Submit that holds one
// counts the sitting as traced. Line-based and deterministic — no model, no backtracking regex.
//
// A block is a Python `"""`/`'''` string, a `/* … */`, or a run of at least TRACE_BLOCK_MIN_LINES consecutive `#`
// or `//` lines. It is a trace when it holds an input line (`name = <literal>`, or one opening with input /
// example / trace) and at least TRACE_STEP_MIN other step lines (a digit plus one of -> => → = : |). LeetCode's
// starter comments (`:type`, `@param`, "Definition for …") never count. Known limit: three commented-out literal
// assignments read as a trace; the comment only ever upgrades the card's state, never blanks it.

export const TRACE_BLOCK_MIN_LINES = 3;
export const TRACE_STEP_MIN = 2;

const INPUT_WORD_RE = /^(?:input|example|trace)\b/i;
const INPUT_ASSIGN_RE = /^[A-Za-z_]\w*\s*=\s*(?:-?\d|\[|\{|"|')/;
const STEP_MARKS = ['->', '=>', '→', '=', ':', '|'];
const STARTER_MARKS = [':type', ':rtype', '@param', '@return', 'definition for'];

const isInputLine = (l: string) => INPUT_WORD_RE.test(l) || INPUT_ASSIGN_RE.test(l);
const isStepLine = (l: string) => /\d/.test(l) && STEP_MARKS.some((m) => l.includes(m));

// One block's text lines → is it a trace?
export function isTraceBlock(lines: readonly string[]): boolean {
  const body = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (body.some((l) => STARTER_MARKS.some((m) => l.toLowerCase().includes(m)))) return false;
  const input = body.findIndex(isInputLine);
  if (input < 0) return false;
  return body.filter((l, i) => i !== input && isStepLine(l)).length >= TRACE_STEP_MIN;
}

// Every comment block in the code, as its text lines (delimiters and line markers stripped).
export function commentBlocks(code: string): string[][] {
  const lines = code.split(/\r?\n/);
  const blocks: string[][] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length >= TRACE_BLOCK_MIN_LINES) blocks.push(run);
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const line = t.startsWith('#') ? t.slice(1) : t.startsWith('//') ? t.slice(2) : null;
    if (line !== null) {
      run.push(line);
      continue;
    }
    flushRun();
    const delim = ['"""', "'''", '/*'].find((d) => t.includes(d));
    if (!delim) continue;
    const close = delim === '/*' ? '*/' : delim;
    const after = t.slice(t.indexOf(delim) + delim.length);
    if (after.includes(close)) continue; // opened and closed on one line: not a multi-line block
    const block = [after];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.includes(close)) {
        block.push(l.slice(0, l.indexOf(close)));
        break;
      }
      block.push(delim === '/*' ? l.trim().replace(/^\*/, '') : l);
    }
    if (j >= lines.length) break; // never closed: still being typed, not a block yet
    blocks.push(block);
    i = j;
  }
  flushRun();
  return blocks;
}

export const traceCommentIn = (code: string): boolean => commentBlocks(code).some(isTraceBlock);
