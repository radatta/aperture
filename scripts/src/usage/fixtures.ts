// Synthetic builders for the usage tests. Every id, name, number and timestamp here is invented (the repo is
// public: docs/ops/PUBLIC-CONTENT.md) — never paste a real transcript row or meter reading in.

export const SID = '00000000-0000-4000-8000-000000000001';
export const SID2 = '00000000-0000-4000-8000-000000000002';

export interface UsageIn {
  i?: number;
  cw?: number;
  cw5?: number;
  cw1?: number;
  cr?: number;
  o?: number;
  speed?: string;
  split?: boolean;
}

export function assistantRow(o: {
  id?: string;
  ts?: string;
  model?: string;
  usage?: UsageIn | null;
  tools?: Record<string, unknown>[];
  cwd?: string;
  sid?: string;
  requestId?: string;
}): string {
  const u = o.usage === null ? undefined : (o.usage ?? { i: 10, cw: 100, cr: 1000, o: 50 });
  const cw = u ? (u.cw ?? (u.cw5 ?? 0) + (u.cw1 ?? 0)) : 0;
  const usage = u && {
    input_tokens: u.i ?? 0,
    cache_creation_input_tokens: cw,
    cache_read_input_tokens: u.cr ?? 0,
    output_tokens: u.o ?? 0,
    ...(u.split === false
      ? {}
      : {
          cache_creation: {
            ephemeral_5m_input_tokens: u.cw5 ?? cw - (u.cw1 ?? 0),
            ephemeral_1h_input_tokens: u.cw1 ?? 0,
          },
        }),
    ...(u.speed ? { speed: u.speed } : {}),
  };
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts ?? '2026-01-05T10:00:00.000Z',
    sessionId: o.sid ?? SID,
    cwd: o.cwd ?? '/workspace/.claude/worktrees/lane-a',
    requestId: o.requestId ?? 'req_fix_01',
    message: {
      id: o.id ?? 'msg_fix_01',
      model: o.model ?? 'claude-opus-5-5',
      content: (o.tools ?? []).map((t, n) => ({ type: 'tool_use', id: `toolu_fix_${n}`, ...t })),
      ...(usage ? { usage } : {}),
    },
  });
}

export const bash = (command: string) => ({ name: 'Bash', input: { command } });
export const agent = (subagent_type: string) => ({
  name: 'Agent',
  input: { subagent_type, prompt: 'synthetic' },
});
export const edit = (file_path: string) => ({ name: 'Edit', input: { file_path } });

export const titleRow = (name: string) =>
  JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: SID });

// A status-line meter row (scripts/usage/statusline-log.sh's shape).
export function meterRow(o: {
  ts: string;
  sid?: string;
  name?: string;
  cost?: number | null;
  pct?: number | null;
  resetsAt?: number;
}): string {
  return JSON.stringify({
    ts: o.ts,
    sid: o.sid ?? SID,
    name: o.name ?? 'lane-a',
    cwd: '/workspace/.claude/worktrees/lane-a',
    branch: null,
    pr: null,
    agent: null,
    model: 'claude-opus-5-5',
    cost: o.cost === undefined ? 1 : o.cost,
    rl:
      o.pct === null
        ? null
        : { seven_day: { used_percentage: o.pct ?? 10, resets_at: o.resetsAt ?? 1_800_000_000 } },
    lv: 1,
  });
}
