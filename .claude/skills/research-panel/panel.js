export const meta = {
  name: 'research-panel',
  description:
    'Research panel: 1 scout splits the question into N angles -> N parallel web researchers -> 1 synthesizer',
  whenToUse: 'Only from the /research-panel skill, which the user invoked.',
  phases: [
    { title: 'Scout', detail: 'split the question into N research angles (default sonnet)' },
    { title: 'Research', detail: 'N parallel search-specialist researchers (default 5, sonnet)' },
    { title: 'Synthesize', detail: 'one report: documented / anecdotal / unknown (default opus)' },
  ],
};
// Run from the research-panel skill:
// Workflow({scriptPath: '<skill dir>/panel.js', args: {question, context, researchers?, models?}})
// The Workflow runtime provides these (and allows the top-level return); meta must stay the first statement.
/* global args, log, phase, agent, parallel */

const A = typeof args === 'string' ? { question: args } : args || {};
const QUESTION = String(A.question || '').trim();
if (!QUESTION) return { error: 'no question: pass args.question' };
const CONTEXT = String(A.context || '').trim() || '(no context given)';
const N = Math.min(8, Math.max(1, Math.round(Number(A.researchers) || 5)));
if (A.researchers && N !== Number(A.researchers)) log(`researchers clamped to ${N} (1-8)`);
const M = { scout: 'sonnet', researcher: 'sonnet', synth: 'opus', ...(A.models || {}) };

const RULES = `RULES (hard; breaking the sandbox ones freezes or kills the shared machine you run on):
- Never put a reverse-shell shape in any Bash command or search pattern: no "nc -e", "bash -i"/"sh -i", "socket.socket", "fsockopen", "/dev/tcp/", "socat" or "powershell" near a host/port, and no "python3 -c"/"perl -e"/"node -e" together with tcp/udp/socket/an IP/host:port. Use a heredoc script instead of a one-liner.
- Never write "/curl" or "/wget" (with the leading slash) anywhere in a Bash command. Prefer WebFetch to curl.
- Never connect to, or mention, port 8080. Never grep for the word "socket".
- Never read, list or search .secrets/ (any tool).
- You are a web researcher: don't search the local disk unless your prompt names a file. Any local search is scoped to one directory, wrapped as "timeout 60 nice -n 10 rg ... <dir> | head -500"; never scan ~, ~/.claude, a checkout root or all worktrees.
- Read-only: no file edits, no commits, no pushes, no writes to GitHub or any connected service.
- Privacy: no repo name, owner, GitHub login, domain, person's name, email, home or Mac path, or any personal detail in a search query or a fetched URL. Search with generic product-category wording ("a personal productivity PWA on AWS serverless"), never the project's own names.`;

const SETUP = `THE QUESTION: ${QUESTION}

CONTEXT (scrubbed; generic on purpose): ${CONTEXT}`;

const EVIDENCE = `Keep three parts apart: DOCUMENTED (official docs, specs, source code; with URLs), ANECDOTAL/OBSERVED (issues, forums, blog posts, release notes of real use; with URLs), STILL UNKNOWN (what no source settles, and what only a local test would settle, with the test).`;

phase('Scout');
const scout = await agent(
  `${RULES}

${SETUP}

You are the scout. Spend only a few quick searches getting oriented, then split the question into exactly ${N} independent research angles for ${N} parallel web researchers. Make the angles non-overlapping and, together, complete. Each angle's prompt must be self-contained (the researcher sees only your prompt plus the question and context) and say what to return.`,
  {
    label: 'scout',
    phase: 'Scout',
    model: M.scout,
    schema: {
      type: 'object',
      properties: {
        angles: {
          type: 'array',
          minItems: N,
          maxItems: N,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              title: { type: 'string' },
              prompt: { type: 'string' },
            },
            required: ['key', 'title', 'prompt'],
          },
        },
        notes: { type: 'string' },
      },
      required: ['angles'],
    },
  },
);
if (!scout) return { error: 'scout failed' };
log(`angles: ${scout.angles.map((a) => a.title).join(' | ')}`);

phase('Research');
const reports = await parallel(
  scout.angles.map(
    (a) => () =>
      agent(
        `${RULES}

${SETUP}

YOUR ANGLE: ${a.title}
${a.prompt}

Do real research: primary sources first (official docs, specs, the tool's own README or source), several searches, read the pages rather than the snippets. Return a markdown report. ${EVIDENCE} End with your angle's bottom line for the question, one paragraph.`,
        {
          label: `research:${a.key}`,
          phase: 'Research',
          model: M.researcher,
          agentType: 'search-specialist',
        },
      ).then((r) => (r ? `## ${a.title}\n\n${r}` : null)),
  ),
);
const got = reports.filter(Boolean);
if (got.length < N) log(`${N - got.length} of ${N} researcher(s) returned nothing`);
if (!got.length) return { error: 'no researcher returned a report', angles: scout.angles };

phase('Synthesize');
const report = await agent(
  `${RULES}

${SETUP}

You are the synthesizer. Below are ${got.length} independent research reports${got.length < N ? ` (${N - got.length} of ${N} angles came back empty: name them as uncovered)` : ''}. Cross-check them: where they disagree, say which source wins and why. Then write the final report in markdown for a busy reader in a terminal (no HTML, plain lists, short paragraphs):
1. Bottom line in 3-5 lines: the answer, and how confident.
2. Findings, by sub-question.
3. ${EVIDENCE}
4. Sources (URLs).
Do not invent sources; a claim no report backs is unknown, and says so. Use web tools yourself only when a key fact conflicts across reports.

${got.join('\n\n---\n\n')}`,
  { label: 'synthesize', phase: 'Synthesize', model: M.synth },
);

return {
  question: QUESTION,
  models: M,
  researchers: N,
  angles: scout.angles.map((a) => a.title),
  report,
};
