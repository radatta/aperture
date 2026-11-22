// The template doc and the three agent files against the lint: the doc's section names, light drops, pre-mortem
// classes and evidence prefixes are the lint's own lists, and the doc's example rows pass the lint; the agent files
// have no file-write tool, their exact tool sets, and `high`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isReviewLens } from '../usage/prs.ts';
import {
  cells,
  CLASSES,
  EVIDENCE,
  LIGHT_DROPS,
  lint,
  SECTIONS_FULL,
  unfence,
  type Tree,
} from './lint.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DOC = read('docs/ops/PLAN.md');

// The rows of the first table after the line that starts with `start`.
function tableAfter(text: string, start: RegExp): string[][] {
  const lines = unfence(text.split('\n'));
  const i = lines.findIndex((l) => start.test(l));
  if (i < 0) return [];
  const rows: string[][] = [];
  let seen = false;
  for (const l of lines.slice(i + 1)) {
    if (l.trimStart().startsWith('|')) {
      seen = true;
      if (!/^\|\s*:?-{3,}/.test(l.trim())) rows.push(cells(l));
    } else if (seen) break;
  }
  return rows.slice(1); // drop the header
}

describe('docs/ops/PLAN.md matches the lint', () => {
  const table = tableAfter(DOC, /^## Full or light/);

  it('lists exactly the lint’s sections, in order', () => {
    expect(table.map((r) => r[0])).toEqual([...SECTIONS_FULL]);
  });

  it('leaves out in light exactly what the lint drops', () => {
    expect(table.filter((r) => /left out/.test(r[2]!)).map((r) => r[0])).toEqual([...LIGHT_DROPS]);
  });

  it('names every pre-mortem class and evidence prefix', () => {
    expect(tableAfter(DOC, /^\*\*Pre-mortem\*\*/).map((r) => r[1])).toEqual([...CLASSES]);
    for (const e of EVIDENCE) expect(DOC).toContain(`\`${e}\``);
  });

  it('its example rows, put together as a plan, pass the lint', () => {
    // The examples' headers matter to the lint (Writers, Readers, Searches, Version, Evidence, Class): keep them.
    const real = (name: string, heading: RegExp) => {
      const lines = unfence(DOC.split('\n'));
      const i = lines.findIndex((l) => heading.test(l));
      const start = lines.findIndex((l, j) => j > i && l.trimStart().startsWith('|'));
      let end = start;
      while (lines[end]?.trimStart().startsWith('|')) end++;
      return [`## ${name}`, '', ...lines.slice(start, end), ''];
    };
    const plan = [
      '# Plan: example',
      '',
      'Template: full — the template doc’s own examples',
      '',
      '## Operator steps',
      '',
      'none',
      '',
      '## Files',
      '',
      '| # | File |',
      '| --- | --- |',
      '| 1 | `packages/x/src/write.ts` |',
      '',
      ...real('Change census', /^\*\*Change census\*\*/),
      ...real('Unknowns', /^\*\*Unknowns\*\*/),
      // the doc shows one invariant; full takes three
      ...real('Invariants', /^\*\*Invariants\*\*/),
      '',
      ...real('Ordering and races', /^\*\*Ordering and races\*\*/),
      ...real('Pre-mortem', /^\*\*Pre-mortem\*\*/),
      ...real('Test matrix', /^\*\*Test matrix\*\*/),
      '## Step plan',
      '',
      '| # | Step | Phase key | Minutes | From |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | build | build | 20–40 | no history |',
      '',
      '## Open questions',
      '',
      'none',
      '',
    ].join('\n');
    const everything: Tree = {
      topLevel: new Set(['packages', 'docs', 'tools']),
      exists: () => true,
      lineCount: () => 1000,
    };
    const problems = lint(plan, everything).problems.map((p) => `${p.check}: ${p.message}`);
    expect(problems).toEqual(['invariant: full takes 3–7 invariants, found 1']);
  });
});

// An agent file's frontmatter: only the known keys, each once (YAML keeps the last of a repeated key, a line scan the
// first), no file-write or MCP tool, effort pinned at high.
const WRITE_TOOLS = /^(Edit|Write|NotebookEdit|Agent|Task)$|^mcp__/;
const KEYS = new Set(['name', 'description', 'tools', 'model', 'effort']);
function frontmatter(text: string): { fields: Map<string, string>; out: string[] } | null {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (fm === undefined) return null;
  const fields = new Map<string, string>();
  const out: string[] = [];
  for (const line of fm.split('\n')) {
    const m = /^([^\s:]+):\s*(.*)$/.exec(line);
    if (!m) {
      out.push(`not a key: value line: ${line}`);
      continue;
    }
    const [, k, v] = m as unknown as [string, string, string];
    if (!KEYS.has(k)) out.push(`key ${k} is not one of ${[...KEYS].join(', ')}`);
    if (fields.has(k)) out.push(`key ${k} appears twice`);
    fields.set(k, v.trim());
  }
  return { fields, out };
}
function agentProblems(text: string): string[] {
  const f = frontmatter(text);
  if (!f) return ['no frontmatter'];
  const { fields, out } = f;
  const tools = fields.get('tools');
  if (!tools)
    out.push('no tools: line (an agent without one inherits every tool, MCP writes included)');
  else for (const t of tools.split(/\s*,\s*/)) if (WRITE_TOOLS.test(t)) out.push(`write tool ${t}`);
  if (fields.get('effort') !== 'high')
    out.push(`effort is ${fields.get('effort') ?? 'unset'}, not high`);
  if (!fields.get('model')) out.push('no model: line');
  return out;
}
const field = (text: string, k: string) => frontmatter(text)?.fields.get(k);

describe('agent files', () => {
  const good = '---\nname: x\ntools: Read, Grep, Glob\nmodel: opus\neffort: high\n---\n\nbody\n';

  it('the checker passes a file with no write tool and rejects the rest', () => {
    expect(agentProblems(good)).toEqual([]);
    expect(agentProblems(good.replace('tools: Read, Grep, Glob\n', ''))[0]).toMatch(/^no tools:/);
    expect(agentProblems(good.replace('Glob', 'Glob, Write'))).toEqual(['write tool Write']);
    expect(agentProblems(good.replace('Glob', 'Glob, mcp__aperture__create_task'))).toEqual([
      'write tool mcp__aperture__create_task',
    ]);
    expect(agentProblems(good.replace('effort: high', 'effort: xhigh'))).toEqual([
      'effort is xhigh, not high',
    ]);
    expect(agentProblems(good.replace('effort: high\n', ''))).toEqual([
      'effort is unset, not high',
    ]);
    expect(agentProblems('no frontmatter')).toEqual(['no frontmatter']);
    expect(agentProblems(good.replace('model: opus', 'model: opus\ntools: Read, Bash'))).toEqual([
      'key tools appears twice',
    ]);
    expect(agentProblems(good.replace('model: opus', 'model: opus\nmcpServers: x'))).toEqual([
      'key mcpServers is not one of name, description, tools, model, effort',
    ]);
  });

  it('the tool pin reads the frontmatter only, never a matching line in the body', () => {
    const body =
      good.replace('tools: Read, Grep, Glob', 'tools: Read, Bash') + 'tools: Read, Grep, Glob\n';
    expect(field(body, 'tools')).toBe('Read, Bash');
  });

  // Exact-case: the /workspace mount is case-insensitive, CI's Linux isn't.
  const agentFiles = existsSync(join(ROOT, '.claude/agents'))
    ? readdirSync(join(ROOT, '.claude/agents'))
    : [];
  const names = read('CLAUDE.md').includes('.claude/agents/plan.md');
  const has = ['plan.md', 'plan-reviewer.md', 'plan-link-checker.md'].some((f) =>
    agentFiles.includes(f),
  );
  // Tools pinned exactly, so a widening is a red test. Bash is read-only by instruction only: the reviewer, which
  // re-runs searches, has no web tool, and the link checker has nothing local; Plan holds both by design.
  const TOOLS: Record<string, string> = {
    'plan.md': 'Read, Grep, Glob, Bash, WebFetch, WebSearch',
    'plan-reviewer.md': 'Read, Grep, Glob, Bash',
    'plan-link-checker.md': 'WebFetch',
  };

  it.runIf(names || has)('the three plan agents: exact tools, high, Plan on fable', () => {
    for (const [f, tools] of Object.entries(TOOLS)) {
      expect(agentFiles, `${f}, exact case`).toContain(f);
      const text = read(`.claude/agents/${f}`);
      expect(agentProblems(text), f).toEqual([]);
      expect(field(text, 'tools'), f).toBe(tools);
    }
    expect(names, 'CLAUDE.md names .claude/agents/plan.md').toBe(true);
    const fm = (f: string, k: string) => field(read(`.claude/agents/${f}`), k);
    expect(fm('plan.md', 'name')).toBe('Plan');
    expect(fm('plan.md', 'model')).toBe('fable');
    expect(fm('plan-reviewer.md', 'name')).toBe('plan-reviewer');
    expect(fm('plan-link-checker.md', 'name')).toBe('plan-link-checker');
  });

  it('plan-reviewer and plan-link-checker never count as a review round', () => {
    expect(isReviewLens('plan-reviewer')).toBe(false);
    expect(isReviewLens('plan-link-checker')).toBe(false);
  });
});
