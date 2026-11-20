// One Claude Code transcript line → what the cost model keeps: a call's usage (deduped later by message id), the
// session's name, and phase markers from the call's tool_use blocks. Markers hold enums only — never command text,
// paths or content — because the cache is the only thing derived from transcripts (docs/ops/USAGE-METER.md).
import { PHASES, phaseAlias } from '../board/tower/lanes.ts';
import { rowLane } from './lanes.ts';
import type { Tokens } from './prices.ts';

export interface Call extends Tokens {
  id: string;
  ts: number; // epoch ms of the first row seen
  model: string;
  fast: boolean;
  unsplit: boolean; // cache writes had no 5m/1h split, all counted as 5m
  lane?: string; // the lane the row itself was in (lanes.ts rowLane)
  foreign?: boolean; // the row's sessionId isn't its file's: a copy a fork carried over
}

// The phases `pnpm board lane` accepts: the tower's own list, so a new phase parses here too.
export const LANE_PHASES = PHASES;
export type LanePhase = (typeof LANE_PHASES)[number];

export type MarkerKind =
  | 'lane-phase' // explicit `pnpm board lane <phase>`
  | 'plan'
  | 'edit'
  | 'gate'
  | 'review'
  | 'local'
  | 'dev' // bot push / deploy-dev
  | 'devcheck' // a dev-stage devcheck run
  | 'pr'
  | 'commit'
  | 'spawn'
  | 'workflow';
export type EditClass = 'src' | 'test' | 'docs' | 'notes';
export interface Marker {
  ts: number;
  kind: MarkerKind;
  phase?: LanePhase;
  cls?: EditClass;
  agentType?: string;
  toolUseId?: string;
  lane?: string;
  src?: 'log'; // a lane-phase from the phase logger (phaselog.ts), not the transcript
  alias?: true; // written as an alias (`ready`): the CLI refuses it from dev on, so the timeline skips it there
}

export interface Parsed {
  call?: Call;
  sid?: string; // the row's own sessionId
  markers: Marker[];
  name?: string;
  cwd?: string;
}

// Only these lines are parsed; the rest (tool results, attachments, request blobs — most of the bytes) are skipped
// on a byte search. A raw `"type":"assistant"` can't occur inside a JSON string, where quotes are escaped.
const WANTED = ['"type":"assistant"', '"type":"custom-title"', '"type":"agent-name"'].map((s) =>
  Buffer.from(s),
);
export const wanted = (line: Buffer) => WANTED.some((w) => line.includes(w));

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const safeName = (s: unknown) =>
  typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(s) ? s : undefined;
const safeType = (s: unknown) =>
  typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/.test(s) ? s : undefined;

export function editClass(path: string): EditClass {
  if (/(^|\/)localNotes\//.test(path)) return 'notes';
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(__tests__|fixtures)\//.test(path))
    return 'test';
  if (/(^|\/)docs\//.test(path) || /\.md$/i.test(path)) return 'docs';
  return 'src';
}

// Bash command → markers, in the order checked (devcheck:local before devcheck). A command counts only where it
// runs — at the start of the line or of a `&&`/`;`/`|` segment, after `cd …` or env assignments, or as heavy.sh's
// payload — never quoted inside a grep or an echo.
const AT = String.raw`(?:^|[;&|(]\s*|\s--\s+)(?:\w+=\S*\s+)*`;
// pnpm's own options before the script name: lanes run `pnpm -s board lane …` (the silent flag), the hub `pnpm -C <dir> …`
const PNPM = String.raw`pnpm(?:\s+(?:-s|--silent|-w|--workspace-root|-C\s+\S+|--dir(?:=|\s+)\S+))*\s+`;
// the same without a directory: `pnpm -C app test` is one package's run, never the full one
const PNPM_ROOT = String.raw`pnpm(?:\s+(?:-s|--silent|-w|--workspace-root))*\s+`;
const run = (body: string) => new RegExp(`${AT}${body}`, 'm');
const LANE = run(String.raw`${PNPM}board lane (\w+)`);
const LOCAL = run(String.raw`${PNPM}devcheck:local\b`);
const DEVCHECK = run(String.raw`${PNPM}devcheck\b(?!:)`);
const PUSH = run(String.raw`${PNPM}bot (?:push|deploy-dev)\b`);
const OPEN_PR = run(String.raw`${PNPM}mailroom open-pr\b`);
// a full run: nothing after the command but a redirect, a pipe or the next command (`pnpm test <file>` isn't the gate);
// `gate:fast` takes flags, with or without a value (`--base <ref>`), but `--dry-run` and `--help` run nothing
const GATE_FLAG = String.raw`\s+--(?!dry-run\b|help\b)[\w-]+(?:[=\s]+[^\s;&|)>-][^\s;&|)>]*)?`;
const GATE = run(
  String.raw`(?:\S*heavy\.sh\s+--\s+)?(?:${PNPM_ROOT}(?:typecheck|lint|test)|${PNPM}gate:fast(?:${GATE_FLAG})*)(?=\s*(?:$|[;&|)>]|2>))`,
);
const COMMIT = run(String.raw`git (?:-C \S+ )?commit\b`);

export function bashMarkers(cmd: string): Omit<Marker, 'ts'>[] {
  const out: Omit<Marker, 'ts'>[] = [];
  const raw = LANE.exec(cmd)?.[1];
  const phase = raw && (phaseAlias(raw) ?? raw);
  if (phase && (LANE_PHASES as readonly string[]).includes(phase))
    out.push({
      kind: 'lane-phase',
      phase: phase as LanePhase,
      ...(phase !== raw ? { alias: true as const } : {}),
    });
  if (LOCAL.test(cmd)) out.push({ kind: 'local' });
  else if (DEVCHECK.test(cmd)) out.push({ kind: 'devcheck' });
  if (PUSH.test(cmd)) out.push({ kind: 'dev' });
  if (OPEN_PR.test(cmd)) out.push({ kind: 'pr' });
  if (GATE.test(cmd)) out.push({ kind: 'gate' });
  if (COMMIT.test(cmd)) out.push({ kind: 'commit' });
  return out;
}

function toolMarkers(block: Record<string, unknown>): Omit<Marker, 'ts'>[] {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const id = typeof block.id === 'string' ? block.id : undefined;
  // every marker carries its tool-use id, so a re-read never doubles one and two real calls never merge
  return rawMarkers(block, input, id).map((m) => (id ? { ...m, toolUseId: id } : m));
}

function rawMarkers(
  block: Record<string, unknown>,
  input: Record<string, unknown>,
  id: string | undefined,
): Omit<Marker, 'ts'>[] {
  switch (block.name) {
    case 'Bash':
      return typeof input.command === 'string' ? bashMarkers(input.command) : [];
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'MultiEdit': {
      const path = input.file_path ?? input.notebook_path;
      return typeof path === 'string' ? [{ kind: 'edit', cls: editClass(path) }] : [];
    }
    case 'Agent':
    case 'Task': {
      const agentType = safeType(input.subagent_type) ?? 'general-purpose';
      const spawn = { kind: 'spawn' as const, agentType, toolUseId: id };
      if (agentType === 'Plan') return [{ kind: 'plan' }, spawn];
      if (agentType === 'code-reviewer') return [{ kind: 'review' }, spawn];
      return [spawn];
    }
    case 'Skill':
      return input.skill === 'code-review' ? [{ kind: 'review' }] : [];
    case 'Workflow':
      return [{ kind: 'workflow', toolUseId: id }];
    default:
      return [];
  }
}

export function parseLine(line: Buffer | string): Parsed | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
  } catch {
    return null;
  }
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'custom-title') return { markers: [], name: safeName(row.customTitle) };
  if (row.type === 'agent-name') return { markers: [], name: safeName(row.agentName) };
  if (row.type !== 'assistant') return null;
  const ts = Date.parse(String(row.timestamp));
  if (!Number.isFinite(ts)) return null;
  const msg = (row.message ?? {}) as Record<string, unknown>;
  const out: Parsed = {
    markers: [],
    cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
    sid: typeof row.sessionId === 'string' ? row.sessionId : undefined,
  };
  const lane = rowLane(row.cwd, row.gitBranch);
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const b of content)
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use')
      out.markers.push(
        ...toolMarkers(b as Record<string, unknown>).map((m) => ({
          ts,
          ...m,
          ...(lane ? { lane } : {}),
        })),
      );
  const u = msg.usage as Record<string, unknown> | undefined;
  const model = typeof msg.model === 'string' ? msg.model : '';
  const id =
    (typeof msg.id === 'string' && msg.id) || (typeof row.requestId === 'string' && row.requestId);
  if (u && id && model && model !== '<synthetic>') {
    const cc = u.cache_creation as Record<string, unknown> | undefined;
    const cwTotal = num(u.cache_creation_input_tokens);
    const split = !!cc && ('ephemeral_5m_input_tokens' in cc || 'ephemeral_1h_input_tokens' in cc);
    const cw1 = split ? num(cc?.ephemeral_1h_input_tokens) : 0;
    const call: Call = {
      id,
      ts,
      model,
      i: num(u.input_tokens),
      cw5: split ? Math.max(num(cc?.ephemeral_5m_input_tokens), cwTotal - cw1) : cwTotal,
      cw1,
      cr: num(u.cache_read_input_tokens),
      o: num(u.output_tokens),
      fast: u.speed === 'fast',
      unsplit: !split && cwTotal > 0,
      ...(lane ? { lane } : {}),
    };
    if (call.i + call.cw5 + call.cw1 + call.cr + call.o > 0) out.call = call;
  }
  return out;
}

// One request is logged on 2–10 rows (one per content block), each repeating the usage. Keep one call per id with
// each field's max: input and cache counts are exact; output is a lower bound whichever row is kept.
export function mergeCall(a: Call, b: Call): Call {
  return {
    id: a.id,
    ts: Math.min(a.ts, b.ts),
    model: a.model || b.model,
    i: Math.max(a.i, b.i),
    cw5: Math.max(a.cw5, b.cw5),
    cw1: Math.max(a.cw1, b.cw1),
    cr: Math.max(a.cr, b.cr),
    o: Math.max(a.o, b.o),
    fast: a.fast || b.fast,
    unsplit: a.unsplit && b.unsplit,
    ...((a.lane ?? b.lane) ? { lane: a.lane ?? b.lane } : {}),
    ...(a.foreign && b.foreign ? { foreign: true } : {}),
  };
}

export class CallMerger {
  readonly calls = new Map<string, Call>();
  add(c: Call) {
    const prev = this.calls.get(c.id);
    this.calls.set(c.id, prev ? mergeCall(prev, c) : c);
  }
}
