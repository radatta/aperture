// The template doc and the two agent files against the lint: the doc's section names, light drops, pre-mortem
// classes and evidence prefixes are the lint's own lists, and the doc's example rows pass the lint; the agent files
// are read-only and pinned at `high`.
import { existsSync, readFileSync } from 'node:fs';
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

// An agent file's frontmatter: read-only tools, effort pinned at high.
const WRITE_TOOLS = /^(Edit|Write|NotebookEdit|Agent|Task)$|^mcp__/;
function agentProblems(text: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (!fm) return ['no frontmatter'];
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim();
  const out: string[] = [];
  const tools = field('tools');
  if (!tools)
    out.push('no tools: line (an agent without one inherits every tool, MCP writes included)');
  else for (const t of tools.split(/\s*,\s*/)) if (WRITE_TOOLS.test(t)) out.push(`write tool ${t}`);
  if (field('effort') !== 'high') out.push(`effort is ${field('effort') ?? 'unset'}, not high`);
  if (!field('model')) out.push('no model: line');
  return out;
}

describe('agent files', () => {
  const good = '---\nname: x\ntools: Read, Grep, Glob\nmodel: opus\neffort: high\n---\n\nbody\n';

  it('the checker passes a read-only file and rejects the rest', () => {
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
  });

  // Live once CLAUDE.md names the override: both files must then exist and pass.
  const live = read('CLAUDE.md').includes('.claude/agents/Plan.md');
  it.runIf(live)('Plan.md and plan-reviewer.md are read-only at high, Plan on fable', () => {
    for (const f of ['.claude/agents/Plan.md', '.claude/agents/plan-reviewer.md']) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(agentProblems(read(f)), f).toEqual([]);
    }
    expect(read('.claude/agents/Plan.md')).toMatch(/^name: Plan$/m);
    expect(read('.claude/agents/Plan.md')).toMatch(/^model: fable$/m);
  });

  it('plan-reviewer never counts as a review round', () => {
    expect(isReviewLens('plan-reviewer')).toBe(false);
    if (existsSync(join(ROOT, '.claude/agents/plan-reviewer.md')))
      expect(read('.claude/agents/plan-reviewer.md')).toMatch(/^name: plan-reviewer$/m);
  });
});
