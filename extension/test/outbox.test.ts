import { describe, expect, it } from 'vitest';
import {
  SITTING_CALL_BYTES,
  SITTING_CAP_ERROR,
  SITTING_ENDED_ERROR,
  SITTING_EVENTS_PER_CALL,
  SITTING_PAYLOAD_MAX,
} from '@aperture/shared';
import { lib } from './load';

const ob = lib('outbox');
const snap = (i: number, size = 10) => ({
  id: `e${i}`,
  type: 'snapshot',
  at: i,
  payload: { code: 'x'.repeat(size) },
});
const submit = (i: number) => ({ id: `s${i}`, type: 'submit', at: i, payload: { result: {} } });
const queueOf = (...batches: object[][]) =>
  ob.enqueue(
    ob.empty(),
    batches.map((ev, i) => ob.entryOf(`q${i}`, 'SIT', 'two-sum', ev, 0)),
  ).queue;

describe('outbox', () => {
  it('matches the server’s caps and errors', () => {
    expect(ob.MAX_EVENTS).toBe(SITTING_EVENTS_PER_CALL);
    expect(ob.MAX_CALL_BYTES).toBe(SITTING_CALL_BYTES);
    expect(ob.EVENT_MAX).toEqual(SITTING_PAYLOAD_MAX);
    expect(ob.ENDED_ERROR).toBe(SITTING_ENDED_ERROR);
    expect(ob.CAP_ERROR).toBe(SITTING_CAP_ERROR);
  });

  it('splits events into calls the server takes, and drops an event over its own cap', () => {
    const many = Array.from({ length: 120 }, (_, i) => snap(i));
    expect(ob.splitBatch(many).batches.map((b: unknown[]) => b.length)).toEqual([50, 50, 20]);
    const fat = Array.from({ length: 6 }, (_, i) => snap(i, 60 * 1024));
    const { batches } = ob.splitBatch(fat);
    expect(
      batches.every(
        (b: object[]) => b.reduce((n, e) => n + ob.eventBytes(e), 0) <= SITTING_CALL_BYTES,
      ),
    ).toBe(true);
    expect(ob.splitBatch([snap(1, 70 * 1024), snap(2)])).toMatchObject({
      dropped: 1,
      batches: [[{ id: 'e2' }]],
    });
  });

  it('trims an oversized submit down to its verdict instead of dropping it', () => {
    const huge = {
      id: 's1',
      type: 'submit',
      at: 1,
      payload: {
        submissionId: '9',
        request: { typed_code: 'x'.repeat(40 * 1024), lang: 'python3' },
        result: { status_msg: 'Wrong Answer', total_correct: 3, std_output: 'y'.repeat(80 * 1024) },
      },
    };
    const [[kept]] = ob.splitBatch([huge]).batches;
    expect(kept.payload).toMatchObject({
      submissionId: '9',
      trimmed: true,
      request: { typed_code: 'x'.repeat(40 * 1024) },
      result: { status_msg: 'Wrong Answer', total_correct: 3 },
    });
    expect(kept.payload.result.std_output).toBeUndefined();
    const code = {
      ...huge,
      payload: { ...huge.payload, request: { typed_code: 'x'.repeat(100 * 1024) } },
    };
    const [[codeless]] = ob.splitBatch([code]).batches;
    expect(codeless.payload).toMatchObject({
      request: { typed_code: null },
      result: { status_msg: 'Wrong Answer' },
    });
  });

  it('retries a 5xx in order behind nothing, pauses on a 401, and keeps a lone refused event as failed', () => {
    let q = queueOf([snap(1)], [snap(2)]);
    expect(ob.next(q, 0).entry.id).toBe('q0');

    let r = ob.applyResult(q, 'q0', { status: 503, error: 'busy' }, 1000);
    expect(r.outcome).toBe('retry');
    q = r.queue;
    expect(ob.next(q, 1000)).toEqual({ wait: ob.BACKOFF_MS[0] }); // the head holds the line
    r = ob.applyResult(q, 'q0', { status: 200 }, 7000);
    q = r.queue;
    expect(ob.next(q, 7000).entry.id).toBe('q1');

    r = ob.applyResult(q, 'q1', { status: 401, error: 'Unauthorized' }, 8000);
    expect(r.outcome).toBe('paused');
    expect(ob.next(r.queue, 9000)).toBeNull();
    expect(ob.counts(r.queue)).toEqual({ queued: 1, failed: 0, paused: 'auth' });
    expect(ob.next(ob.unpause(r.queue), 9000).entry.id).toBe('q1');

    r = ob.applyResult(
      ob.unpause(r.queue),
      'q1',
      { status: 400, error: 'A snapshot needs its code' },
      9000,
    );
    expect(r.outcome).toBe('failed');
    expect(r.queue.entries[0]).toMatchObject({
      state: 'failed',
      lastStatus: 400,
      lastError: 'A snapshot needs its code',
    });
    expect(ob.next(r.queue, 9000)).toBeNull();
    expect(ob.counts(ob.retryNow(r.queue, 9000)).queued).toBe(1);
    expect(ob.clearFailed(r.queue).entries).toEqual([]);
  });

  it('retries 409, 429 and an unreachable server; backs off longer each time', () => {
    for (const status of [0, 409, 429, 500]) expect(ob.retryable(status)).toBe(true);
    for (const status of [400, 401, 404, 413]) expect(ob.retryable(status)).toBe(false);
    let q = queueOf([snap(1)]);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      q = ob.applyResult(q, 'q0', { status: 429 }, 0).queue;
      waits.push(q.entries[0].nextAt);
    }
    expect(waits).toEqual([...ob.BACKOFF_MS, 300_000, 300_000]);
  });

  it('splits a 413 in two, and fails a lone event the server still finds too large', () => {
    const q = queueOf([snap(1), snap(2), snap(3)]);
    const r = ob.applyResult(q, 'q0', { status: 413 }, 0);
    expect(r.outcome).toBe('split');
    expect(
      r.queue.entries.map((e: { id: string; events: unknown[] }) => [e.id, e.events.length]),
    ).toEqual([
      ['q0.1', 2],
      ['q0.2', 1],
    ]);
    expect(ob.applyResult(queueOf([snap(1)]), 'q0', { status: 413 }, 0).outcome).toBe('failed');
  });

  it('splits a refused batch until the bad event is alone, but not one over the sitting’s cap', () => {
    const q = queueOf([snap(1), submit(2)]);
    const r = ob.applyResult(q, 'q0', { status: 400, error: 'A snapshot needs its code' }, 0);
    expect(r.outcome).toBe('split');
    expect(r.queue.entries.map((e: { events: unknown[] }) => e.events.length)).toEqual([1, 1]);
    expect(ob.applyResult(q, 'q0', { status: 400, error: SITTING_CAP_ERROR }, 0).outcome).toBe(
      'failed',
    );
  });

  it('drops an entry refused because its sitting ended — that is how a sitting ends, not a failure', () => {
    const r = ob.applyResult(
      queueOf([snap(1), snap(2)]),
      'q0',
      { status: 400, error: SITTING_ENDED_ERROR },
      0,
    );
    expect(r.outcome).toBe('ended');
    expect(r.queue.entries).toEqual([]);
    expect(ob.counts(r.queue).failed).toBe(0);
  });

  it('sheds the oldest snapshot-only entries when full, never a submit', () => {
    let q = ob.empty();
    const big = Array.from({ length: 4 }, (_, i) => snap(i, 60 * 1024));
    const entries = Array.from({ length: 30 }, (_, i) => ob.entryOf(`b${i}`, 'SIT', 's', big, 0));
    q = ob.enqueue(q, [ob.entryOf('sub', 'SIT', 's', [submit(1)], 0), ...entries]).queue;
    expect(q.entries[0].id).toBe('sub');
    expect(
      q.entries.reduce((n: number, e: { bytes: number }) => n + e.bytes, 0),
    ).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('sheds raw-bulk entries once no snapshot-only one is left, still never a submit', () => {
    const replay = (i: number) => ({
      id: `r${i}`,
      type: 'replay',
      at: i,
      events: 'z'.repeat(60 * 1024),
    });
    const bulk = Array.from({ length: 100 }, (_, i) =>
      ob.entryOf(`b${i}`, 'SIT', 's', [replay(i)], 0),
    );
    const { queue, shed } = ob.enqueue(ob.empty(), [
      ob.entryOf('sub', 'SIT', 's', [submit(1)], 0),
      ...bulk,
    ]);
    expect(shed).toBeGreaterThan(0);
    expect(queue.entries[0].id).toBe('sub');
    expect(
      queue.entries.reduce((n: number, e: { bytes: number }) => n + e.bytes, 0),
    ).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});
