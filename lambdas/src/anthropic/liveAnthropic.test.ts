import { describe, expect, it } from 'vitest';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createLiveAnthropic } from './liveAnthropic';
import type { ParseRequest } from './gateway';

// No network: fetch and SSM are injected fakes. Asserts the wire shape, where the key goes, every
// failure mapping, and that neither the key nor the typed line ever reaches a log line.

const KEY_PARAM = '/aperture/dev/anthropic/api_key';
const KEY = 'sk-ant-SECRET';
const LINE = 'aperture, call the dentist about the crown 4pm';

function setup(
  respond: () => Response | Promise<Response>,
  params: Record<string, string> = { [KEY_PARAM]: KEY },
) {
  const gets: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const ssm = {
    send: async (cmd: unknown) => {
      if (!(cmd instanceof GetParameterCommand)) throw new Error('unexpected command');
      gets.push(cmd.input.Name!);
      expect(cmd.input.WithDecryption).toBe(true);
      if (!(cmd.input.Name! in params))
        throw Object.assign(new Error('nope'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: params[cmd.input.Name!] } };
    },
  };
  const fetchFake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  const gw = createLiveAnthropic({
    stage: 'dev',
    fetch: fetchFake,
    ssm: ssm as never,
    log: (l) => logs.push(l),
  });
  return { gw, gets, calls, logs };
}

const req: ParseRequest = {
  text: LINE,
  today: '2026-10-12',
  categories: [{ id: 'c1', label: 'Aperture' }],
  timeoutMs: 4_000,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const message = (text: string, stop = 'end_turn') =>
  json(200, {
    stop_reason: stop,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 420, output_tokens: 37 },
  });
const FIELDS = {
  title: 'call the dentist',
  notes: 'about the crown',
  categoryId: 'c1',
  dueDay: null,
  dueTime: '16:00',
  estimateMin: null,
};

describe('createLiveAnthropic', () => {
  it('posts the Raycast-proven wire shape with the key in x-api-key, and returns the fields', async () => {
    const { gw, calls } = setup(() => message(JSON.stringify(FIELDS)));
    expect(await gw.parseTask(req)).toEqual({ ok: true, fields: FIELDS });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 2048,
      // Sonnet 5.5 400s on `disabled`: thinking off is `between_tools`, and nothing else may sit beside it.
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: LINE }],
    });
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.system).toContain('Today is 2026-10-12 (Monday)');
    expect(body.system).toContain('c1: Aperture');
    expect(body.output_config.format.schema.properties.categoryId.anyOf[0].enum).toEqual(['c1']);
  });

  it('a caller-set output cap replaces the default (the capture route bounds its spend)', async () => {
    const { gw, calls } = setup(() => message(JSON.stringify(FIELDS)));
    await gw.parseTask({ ...req, maxTokens: 512, voice: true });
    expect(JSON.parse(calls[0]!.init.body as string).max_tokens).toBe(512);
  });

  it('reads the key once per warm container', async () => {
    const { gw, gets } = setup(() => message(JSON.stringify(FIELDS)));
    await gw.parseTask(req);
    await gw.parseTask(req);
    expect(gets).toEqual([KEY_PARAM]);
  });

  it('a 401 drops the cached key, so a rotated key is picked up on the next call', async () => {
    let status = 401;
    const { gw, gets } = setup(() =>
      status === 401
        ? json(401, { error: { message: 'invalid x-api-key' } })
        : message(JSON.stringify(FIELDS)),
    );
    expect(await gw.parseTask(req)).toMatchObject({ ok: false, reason: 'api' });
    status = 200;
    expect(await gw.parseTask(req)).toMatchObject({ ok: true });
    await gw.parseTask(req);
    expect(gets).toEqual([KEY_PARAM, KEY_PARAM]); // re-read once after the 401, then cached again
  });

  it('no key on the stage → unavailable, and no request is made', async () => {
    const { gw, calls } = setup(() => message('{}'), {});
    expect(await gw.parseTask(req)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'no API key on this stage',
    });
    expect(calls).toHaveLength(0);
  });

  it('maps each failure to its reason', async () => {
    const cases: [() => Response | Promise<Response>, unknown][] = [
      [
        () =>
          Promise.reject(
            Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }),
          ),
        { ok: false, reason: 'timeout' },
      ],
      [
        () => Promise.reject(new TypeError('fetch failed')),
        { ok: false, reason: 'network', detail: 'fetch failed' },
      ],
      [
        () =>
          json(401, {
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
        { ok: false, reason: 'api', detail: 'HTTP 401 invalid x-api-key' },
      ],
      [
        () => new Response('<html>bad gateway</html>', { status: 502 }),
        { ok: false, reason: 'api', detail: 'HTTP 502' },
      ],
      [() => message('{}', 'refusal'), { ok: false, reason: 'api', detail: 'refusal' }],
      [
        () => message('{"title":"cut', 'max_tokens'),
        { ok: false, reason: 'api', detail: 'max_tokens' },
      ],
      [
        // Headers arrived, then the body stalled until the timeout signal fired.
        () =>
          ({
            ok: true,
            status: 200,
            json: () =>
              Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
          }) as unknown as Response,
        { ok: false, reason: 'timeout' },
      ],
      [() => message('not json'), { ok: false, reason: 'bad-json' }],
      [() => message('[1,2]'), { ok: false, reason: 'bad-json' }],
      [
        () => json(200, { stop_reason: 'end_turn', content: [] }),
        { ok: false, reason: 'bad-json' },
      ],
    ];
    for (const [respond, want] of cases)
      expect(await setup(respond).gw.parseTask(req)).toEqual(want);
  });

  it('an SSM error other than not-found is an unavailable outcome, not a throw', async () => {
    const ssm = {
      send: async () =>
        Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' })),
    };
    const gw = createLiveAnthropic({
      stage: 'dev',
      ssm: ssm as never,
      fetch: (() => {
        throw new Error('must not fetch');
      }) as never,
      log: () => {},
    });
    expect(await gw.parseTask(req)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'key read failed (AccessDeniedException)',
    });
  });

  it('the weekly note goes through the same call: Haiku, 256 tokens, the {note} schema, its own log event', async () => {
    const { gw, calls, logs } = setup(() =>
      message(JSON.stringify({ note: 'Rotation twice, 44° to 53°.' })),
    );
    const summary = {
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      totalSets: 2,
      lastWeekSets: 0,
      exercises: [],
    };
    const line = 'This week: 2 sets rotation 44° → 53° · first week';
    expect(await gw.fluxWeekNote({ line, summary, timeoutMs: 6_000 })).toEqual({
      ok: true,
      fields: { note: 'Rotation twice, 44° to 53°.' },
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 256,
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: { type: 'object', required: ['note'], properties: { note: { type: 'string' } } },
        },
      },
    });
    expect(body.system).toContain('one short note about a week of neck exercises');
    expect(body.messages).toEqual([
      { role: 'user', content: expect.stringContaining(`Draft line: ${line}`) },
    ]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      event: 'flux_week_note',
      ok: true,
      status: 200,
      sets: 2,
      input_tokens: 420,
      output_tokens: 37,
    });
    expect(logs[0]).not.toContain('rotation');
    expect(logs[0]).not.toContain(KEY);
  });

  it('logs one line per call with usage — never the key or the text', async () => {
    const { gw, logs } = setup(() => message(JSON.stringify(FIELDS)));
    await gw.parseTask(req);
    const failing = setup(() => json(401, { error: { message: 'invalid x-api-key' } }));
    await failing.gw.parseTask(req);
    const all = [...logs, ...failing.logs];
    expect(all).toHaveLength(2);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      event: 'parse_task',
      ok: true,
      status: 200,
      stop_reason: 'end_turn',
      input_tokens: 420,
      output_tokens: 37,
      chars: LINE.length,
      model: 'claude-sonnet-5-5',
      voice: false,
    });
    // The status is what tells a revoked key from a rate limit or an overload in CloudWatch.
    expect(JSON.parse(failing.logs[0]!)).toMatchObject({
      event: 'parse_task',
      ok: false,
      reason: 'api',
      status: 401,
    });
    for (const l of all) {
      expect(l).not.toContain(KEY);
      expect(l).not.toContain('dentist');
    }
  });
});

describe('coachPick', () => {
  const ctx = {
    today: '2026-11-16',
    candidates: [
      {
        slug: 'two-sum',
        title: 'Two Sum',
        pattern: 'arrays-hashing',
        difficulty: 'Easy',
        kind: 're-solve',
        ifFocus: null,
        rule: 'r',
        history: null,
      },
    ],
    focus: { pattern: 'arrays-hashing', day: 1, of: 3, locked: false },
    top3: ['arrays-hashing'],
    mustInclude: null,
    oldestDue: 'two-sum',
    momentum: { activeDays: 1, of: 7, lastActiveDay: null, missedYesterday: false },
    rates: [],
    recent: [
      {
        day: '2026-11-12',
        slug: 'two-sum',
        pattern: 'arrays-hashing',
        difficulty: 'Easy',
        outcome: 'failed',
        help: 'none',
        cause: null,
        lastError: null,
        minutes: 40,
        capMin: 30,
        notes: 'PRIVATE NOTE',
      },
    ],
  } as never;
  const ANSWER = { picks: [{ slug: 'two-sum', why: 'due' }], note: null, focus: null };

  it('runs Opus 5.5 with thinking left on (never disabled), effort medium, its schema and its own log event', async () => {
    const { gw, calls, logs } = setup(() => message(JSON.stringify(ANSWER)));
    const out = await gw.coachPick({ ctx, timeoutMs: 60_000 });
    expect(out).toEqual({
      ok: true,
      fields: ANSWER,
      model: 'claude-opus-5-5',
      usage: { input: 420, output: 37 },
      ms: expect.any(Number),
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body).not.toHaveProperty('thinking');
    expect(body.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(body.max_tokens).toBe(8000);
    const line = JSON.parse(logs[0]!);
    expect(line).toMatchObject({
      event: 'coach_pick',
      ok: true,
      candidates: 1,
      attempts: 1,
      input_tokens: 420,
      output_tokens: 37,
    });
    expect(logs.join('\n')).not.toMatch(/PRIVATE NOTE|two-sum|SECRET/);
  });

  it('a refusal is its own reason, with the tokens kept', async () => {
    const { gw, logs } = setup(() => message('', 'refusal'));
    const out = await gw.coachPick({ ctx, timeoutMs: 60_000 });
    expect(out).toMatchObject({ ok: false, reason: 'refusal', usage: { input: 420, output: 37 } });
    expect(JSON.parse(logs[0]!)).toMatchObject({ reason: 'refusal', stop_reason: 'refusal' });
  });

  it('max_tokens and HTTP errors are api failures', async () => {
    expect(
      await setup(() => message('{', 'max_tokens')).gw.coachPick({ ctx, timeoutMs: 1 }),
    ).toMatchObject({ ok: false, reason: 'api' });
    expect(
      await setup(() => json(529, { error: { message: 'overloaded' } })).gw.coachPick({
        ctx,
        timeoutMs: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'api', usage: null });
  });

  it('the Haiku calls still turn thinking off with `disabled`, the Sonnet parse with `between_tools`', async () => {
    const { gw, calls } = setup(() => message(JSON.stringify({ note: 'ok' })));
    const summary = {
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      totalSets: 0,
      lastWeekSets: 0,
      exercises: [],
    };
    await gw.fluxWeekNote({ line: 'x', summary, timeoutMs: 1 });
    await gw.parseTask(req);
    const [note, parse] = calls.map((c) => JSON.parse(c.init.body as string));
    expect(note.thinking).toEqual({ type: 'disabled' });
    expect(parse.thinking).toEqual({ type: 'between_tools' });
    expect([note.output_config.effort, parse.output_config.effort]).toEqual(['low', 'low']);
  });
});

describe('catalogClassify', () => {
  const rows = [
    {
      id: 9001,
      slug: 'synthetic-a',
      title: 'Synthetic A',
      difficulty: 'Medium' as const,
      premium: false,
      acRate: 40,
      tags: ['Array'],
      algorithms: true,
    },
  ];
  const ANSWER = { items: [{ id: 9001, pattern: 'heap', similar: [], harder: [] }] };

  it('runs Sonnet 5.5 without a thinking field (disabled is a 400), at low effort, with its own log event', async () => {
    const { gw, calls, logs } = setup(() => message(JSON.stringify(ANSWER)));
    const out = await gw.catalogClassify({ rows, timeoutMs: 45_000 });
    expect(out).toEqual({
      ok: true,
      fields: ANSWER,
      model: 'claude-sonnet-5-5',
      usage: { input: 420, output: 37 },
      ms: expect.any(Number),
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body).not.toHaveProperty('thinking');
    expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: 'catalog_classify', ok: true, rows: 1 });
    expect(logs.join('\n')).not.toMatch(/Synthetic A|SECRET/);
  });

  it('keeps the usage of a failed call, so the job can price it', async () => {
    const out = await setup(() => message('{', 'max_tokens')).gw.catalogClassify({
      rows,
      timeoutMs: 1,
    });
    expect(out).toMatchObject({ ok: false, reason: 'api', usage: { input: 420, output: 37 } });
  });
});
