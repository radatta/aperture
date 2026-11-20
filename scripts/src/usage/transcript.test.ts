import { describe, expect, it } from 'vitest';
import { normalizeModel, priceCall } from './prices.ts';
import { CallMerger, bashMarkers, editClass, parseLine, wanted } from './transcript.ts';
import { fileRef, laneOf } from './lanes.ts';
import { SID, agent, assistantRow, bash, edit, titleRow } from './fixtures.ts';

const T = { i: 0, cw5: 0, cw1: 0, cr: 0, o: 0 };

describe('prices', () => {
  it('normalises ids: prefix, date suffix, [1m], dots, Mythos as Fable', () => {
    expect(normalizeModel('claude-opus-5-5')).toBe('opus-5-5');
    expect(normalizeModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5');
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('opus-5-5');
    expect(normalizeModel('claude-mythos-5-2')).toBe('fable-5-2');
  });

  it('prices each token kind at its own rate, 1 QU = $1 per call', () => {
    // Opus 5.5: 4 / 5 / 8 / 0.20 / 20 per MTok
    const { qu, flags } = priceCall('claude-opus-5-5', {
      i: 1e6,
      cw5: 1e6,
      cw1: 1e6,
      cr: 1e6,
      o: 1e6,
    });
    expect(qu).toBeCloseTo(4 + 5 + 8 + 0.2 + 20);
    expect(flags).toEqual([]);
  });

  it('flags an unknown model and prices it as Opus 5.5; doubles fast mode', () => {
    expect(priceCall('claude-nova-1', { ...T, o: 1e6 })).toEqual({
      qu: 20,
      flags: ['unknown-model'],
    });
    expect(priceCall('claude-opus-5-5', { ...T, o: 1e6 }, { fast: true })).toEqual({
      qu: 40,
      flags: ['fast'],
    });
  });

  it('moves Haiku 5.5 to the long-prompt tier past 100k prompt tokens', () => {
    expect(priceCall('claude-haiku-5-5', { ...T, i: 1e5 }).qu).toBeCloseTo(0.01);
    expect(priceCall('claude-haiku-5-5', { ...T, i: 1e5 + 1 }).qu).toBeCloseTo(0.0500005);
  });
});

describe('transcript lines', () => {
  it('reads one call with the 5m/1h cache split, and only parses wanted lines', () => {
    const row = assistantRow({ usage: { i: 2, cw5: 30, cw1: 70, cr: 900, o: 40 } });
    expect(wanted(Buffer.from(row))).toBe(true);
    expect(wanted(Buffer.from('{"type":"user","content":"\\"type\\":\\"assistant\\""}'))).toBe(
      false,
    );
    expect(parseLine(Buffer.from(row))?.call).toMatchObject({
      id: 'msg_fix_01',
      model: 'claude-opus-5-5',
      i: 2,
      cw5: 30,
      cw1: 70,
      cr: 900,
      o: 40,
      fast: false,
      unsplit: false,
    });
  });

  it('counts an unsplit cache write as 5m and says so; reads fast mode', () => {
    const c = parseLine(assistantRow({ usage: { cw: 100, split: false, speed: 'fast' } }))?.call;
    expect(c).toMatchObject({ cw5: 100, cw1: 0, unsplit: true, fast: true });
  });

  it('drops synthetic and all-zero calls, malformed lines and other row types', () => {
    expect(parseLine(assistantRow({ model: '<synthetic>' }))?.call).toBeUndefined();
    expect(parseLine(assistantRow({ usage: {} }))?.call).toBeUndefined();
    expect(parseLine(assistantRow({ usage: null }))?.call).toBeUndefined();
    expect(parseLine('{"type":"assistant", trunc')).toBeNull();
    expect(parseLine('{"type":"user"}')).toBeNull();
  });

  it('falls back to the request id when the message has none', () => {
    const row = JSON.parse(assistantRow({ requestId: 'req_fix_9' }));
    delete row.message.id;
    expect(parseLine(JSON.stringify(row))?.call?.id).toBe('req_fix_9');
  });

  it('takes the session name from custom-title and agent-name rows, refusing odd text', () => {
    expect(parseLine(titleRow('lane-a'))?.name).toBe('lane-a');
    expect(parseLine(JSON.stringify({ type: 'agent-name', agentName: 'hub' }))?.name).toBe('hub');
    expect(parseLine(titleRow('a\nb $(x)'))?.name).toBeUndefined();
  });

  it('dedupes the 2–10 rows of one request by id, keeping each field max and the earliest ts', () => {
    const m = new CallMerger();
    for (const [ts, o] of [
      ['2026-01-05T10:00:02Z', 5],
      ['2026-01-05T10:00:01Z', 300],
      ['2026-01-05T10:00:03Z', 120],
    ] as const)
      m.add(parseLine(assistantRow({ ts, usage: { i: 1, cw: 10, cr: 100, o } }))!.call!);
    expect([...m.calls.values()]).toEqual([
      expect.objectContaining({ ts: Date.parse('2026-01-05T10:00:01Z'), o: 300, cr: 100 }),
    ]);
  });
});

describe('markers', () => {
  it('reads an explicit `pnpm board lane <phase>` and ignores an unknown phase', () => {
    expect(bashMarkers('pnpm board lane review --step "round 2"')).toEqual([
      { kind: 'lane-phase', phase: 'review' },
    ]);
    expect(bashMarkers('pnpm board lane --clear')).toEqual([]);
  });

  it('tells devcheck:local from devcheck, and finds push, open-pr, the gate and commits', () => {
    expect(bashMarkers('pnpm devcheck:local --tier full')).toEqual([{ kind: 'local' }]);
    expect(bashMarkers('pnpm devcheck --tier full')).toEqual([{ kind: 'devcheck' }]);
    expect(bashMarkers('pnpm bot push')).toEqual([{ kind: 'dev' }]);
    expect(bashMarkers('pnpm mailroom open-pr --title x')).toEqual([{ kind: 'pr' }]);
    expect(bashMarkers('scripts/board/heavy.sh -- pnpm typecheck')).toEqual([{ kind: 'gate' }]);
    expect(bashMarkers('pnpm test:unit')).toEqual([]);
    expect(bashMarkers('git add -A && git commit -m "fixed it"')).toEqual([{ kind: 'commit' }]);
    expect(bashMarkers('cd /w/x && CI=true pnpm test')).toEqual([{ kind: 'gate' }]);
    expect(bashMarkers('set -o pipefail; pnpm typecheck 2>&1 | tail -3')).toEqual([
      { kind: 'gate' },
    ]);
    expect(bashMarkers('pnpm test src/a.test.ts')).toEqual([]); // one file is not the gate
  });

  it("reads pnpm's own options before the script, gate:fast, and ready as local", () => {
    expect(bashMarkers('pnpm -s board lane review --step "round 1" | tail -1')).toEqual([
      { kind: 'lane-phase', phase: 'review' },
    ]);
    expect(bashMarkers('pnpm -C /w --silent board lane gate')).toEqual([
      { kind: 'lane-phase', phase: 'gate' },
    ]);
    expect(bashMarkers('pnpm --dir=/w board lane ready --step x')).toEqual([
      { kind: 'lane-phase', phase: 'local' },
    ]);
    expect(bashMarkers('pnpm -s board lane constructor')).toEqual([]);
    expect(bashMarkers('pnpm -s devcheck:local --tier full')).toEqual([{ kind: 'local' }]);
    expect(bashMarkers('pnpm -s devcheck --tier full')).toEqual([{ kind: 'devcheck' }]);
    expect(bashMarkers('pnpm -s bot push')).toEqual([{ kind: 'dev' }]);
    expect(bashMarkers('pnpm -s mailroom open-pr --title x')).toEqual([{ kind: 'pr' }]);
    expect(bashMarkers('set -o pipefail; pnpm -s gate:fast 2>&1 | tail')).toEqual([
      { kind: 'gate' },
    ]);
    expect(bashMarkers('heavy.sh -- pnpm gate:fast --full')).toEqual([{ kind: 'gate' }]);
    expect(bashMarkers('pnpm gate:fast --base origin/main --wait 30 2>&1')).toEqual([
      { kind: 'gate' },
    ]);
    expect(bashMarkers('pnpm gate:fast --base=origin/main')).toEqual([{ kind: 'gate' }]);
    expect(bashMarkers('pnpm -s gate:fast --dry-run')).toEqual([]); // runs nothing
    expect(bashMarkers('pnpm gate:fast --help')).toEqual([]);
    expect(bashMarkers('pnpm -w lint && pnpm --workspace-root typecheck')).toEqual([
      { kind: 'gate' },
    ]);
    // one package's run, not the full one
    expect(bashMarkers('pnpm -C app test')).toEqual([]);
    expect(bashMarkers('pnpm --dir app lint')).toEqual([]);
    expect(bashMarkers('pnpm -C /w gate:fast')).toEqual([{ kind: 'gate' }]);
    expect(bashMarkers('pnpm --dir /w board lane build')).toEqual([
      { kind: 'lane-phase', phase: 'build' },
    ]);
    expect(bashMarkers('pnpm -s test src/a.test.ts')).toEqual([]);
    expect(bashMarkers('grep -n "pnpm -s board lane review" x')).toEqual([]);
  });

  it('ignores commands only mentioned inside another command', () => {
    expect(bashMarkers('grep -n "pnpm board lane review" docs/x.md')).toEqual([]);
    expect(bashMarkers("echo 'then pnpm bot push'")).toEqual([]);
    expect(bashMarkers('rg "pnpm devcheck --tier" scripts/')).toEqual([]);
  });

  it('classes edits by path', () => {
    expect(editClass('/w/app/src/a.ts')).toBe('src');
    expect(editClass('/w/app/src/a.test.tsx')).toBe('test');
    expect(editClass('/w/docs/ops/X.md')).toBe('docs');
    expect(editClass('/w/localNotes/decisions.md')).toBe('notes');
  });

  it('turns tool_use blocks into timestamped markers, Plan and code-reviewer spawns included', () => {
    const p = parseLine(
      assistantRow({
        tools: [agent('Plan'), agent('code-reviewer'), edit('/w/a.ts'), bash('pnpm lint')],
      }),
    )!;
    expect(p.markers.map((m) => m.kind)).toEqual([
      'plan',
      'spawn',
      'review',
      'spawn',
      'edit',
      'gate',
    ]);
    expect(p.markers[1]).toMatchObject({ agentType: 'Plan', toolUseId: 'toolu_fix_0' });
    expect(p.markers[4]).toMatchObject({ kind: 'edit', toolUseId: 'toolu_fix_2' });
    expect(p.markers.every((m) => m.ts === Date.parse('2026-01-05T10:00:00.000Z'))).toBe(true);
  });
});

describe('lanes', () => {
  it('maps transcript paths to main, subagent and workflow refs', () => {
    expect(fileRef(`-workspace/${SID}.jsonl`)).toEqual({
      project: '-workspace',
      sid: SID,
      kind: 'main',
    });
    expect(fileRef(`p/${SID}/subagents/agent-a1b2.jsonl`)).toEqual({
      project: 'p',
      sid: SID,
      agentId: 'a1b2',
      kind: 'subagent',
    });
    expect(fileRef(`p/${SID}/subagents/workflows/wf_ab-12/agent-c3.jsonl`)).toMatchObject({
      agentId: 'c3',
      kind: 'workflow',
    });
    expect(fileRef(`p/${SID}/tool-results/x.txt`)).toBeNull();
    expect(fileRef(`p/${SID}/subagents/agent-a1.meta.json`)).toBeNull();
    expect(fileRef('p/not-a-uuid.jsonl')).toBeNull();
  });

  it('gives worktree sessions their lane, the hub its role, and the rest adhoc or other', () => {
    expect(laneOf('-workspace--claude-worktrees-lc-coach-a', undefined, 'x', 'hub')).toEqual({
      lane: 'lc-coach-a',
      role: 'lane',
    });
    expect(laneOf('-workspace', '/workspace/.claude/worktrees/b-2/app', 'x', 'hub')).toEqual({
      lane: 'b-2',
      role: 'lane',
    });
    expect(laneOf('-workspace', '/workspace', 'hub', 'hub').role).toBe('hub');
    expect(laneOf('-workspace', '/workspace', 'other', 'hub').role).toBe('adhoc');
    expect(laneOf('-home-x', '/home/x', 'hub', 'hub').role).toBe('other');
  });
});
