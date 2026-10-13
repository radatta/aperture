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
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: LINE }],
    });
    expect(body.system).toContain('Today is 2026-10-12 (Monday)');
    expect(body.system).toContain('c1: Aperture');
    expect(body.output_config.format.schema.properties.categoryId.anyOf[0].enum).toEqual(['c1']);
  });

  it('reads the key once per warm container', async () => {
    const { gw, gets } = setup(() => message(JSON.stringify(FIELDS)));
    await gw.parseTask(req);
    await gw.parseTask(req);
    expect(gets).toEqual([KEY_PARAM]);
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
      input_tokens: 420,
      output_tokens: 37,
      chars: LINE.length,
    });
    expect(JSON.parse(failing.logs[0]!)).toMatchObject({
      event: 'parse_task',
      ok: false,
      reason: 'api',
    });
    for (const l of all) {
      expect(l).not.toContain(KEY);
      expect(l).not.toContain('dentist');
    }
  });
});
