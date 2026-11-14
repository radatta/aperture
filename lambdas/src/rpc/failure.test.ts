import { describe, expect, it } from 'vitest';
import { AWS_REFUSED, INTERNAL_ERROR, failureStatus, shownMessage } from './failure';
import { ShapeError } from './shape';

const named = (message: string, name: string, extra: object = {}) =>
  Object.assign(new Error(message), { name, ...extra });
class ConflictError extends Error {
  override name = 'ConflictError';
}
class EventGoneError extends Error {
  override name = 'EventGoneError';
}

describe('failureStatus and shownMessage (one mapping, two paths)', () => {
  const throttle = named('arn:aws:… slow down', 'ThrottlingException', { $metadata: {} });
  const aws4xx = named('arn:aws:… bad item', 'ValidationException', {
    $metadata: { httpStatusCode: 400 },
  });
  const aws5xx = named('arn:aws:… down', 'InternalServerError', {
    $metadata: { httpStatusCode: 503 },
  });
  // [error, ingest status, rpc status]
  const table: [string, unknown, number, number][] = [
    ['Unauthorized', new Error('Unauthorized: missing token'), 401, 401],
    ['Unknown method', new Error('Unknown method: x'), 404, 404],
    ['ShapeError', new ShapeError('task must be an object'), 400, 400],
    ['ConflictError', new ConflictError('Conflict — try again'), 409, 400],
    ['throttle', throttle, 429, 500],
    ['RequestLimitExceeded', named('limit', 'RequestLimitExceeded', { $metadata: {} }), 429, 500],
    ['AWS 4xx', aws4xx, 400, 500],
    ['AWS 5xx', aws5xx, 500, 500],
    ['AWS, no status', named('x', 'Unknown', { $metadata: {} }), 500, 500],
    ['TypeError', new TypeError('our bug'), 500, 500],
    ['RangeError', new RangeError('our bug'), 500, 500],
    ['ReferenceError', new ReferenceError('our bug'), 500, 500],
    ['plain Error', new Error('Not found: x'), 400, 400],
    ['custom subclass', new EventGoneError('gone'), 500, 400],
    ['a thrown string', 'boom', 500, 500],
    ['null', null, 500, 500],
  ];

  it.each(table)('%s → ingest %i, rpc %i', (_label, err, ingest, rpc) => {
    expect(failureStatus(err, 'ingest')).toBe(ingest);
    expect(failureStatus(err, 'rpc')).toBe(rpc);
  });

  it('maps a throttle to 429 on ingest and a fixed 500 on rpc', () => {
    expect(failureStatus(throttle, 'ingest')).toBe(429);
    expect(failureStatus(throttle, 'rpc')).toBe(500);
    expect(shownMessage(throttle, 500)).toBe(INTERNAL_ERROR);
  });

  it('never shows the text of an AWS error', () => {
    for (const err of [throttle, aws4xx, aws5xx])
      for (const path of ['ingest', 'rpc'] as const) {
        const shown = shownMessage(err, failureStatus(err, path));
        expect(shown).not.toContain('arn:aws');
        expect([INTERNAL_ERROR, AWS_REFUSED]).toContain(shown);
      }
  });

  it('shows our own refusals as they are, and a 500 never', () => {
    expect(shownMessage(new ShapeError('title is required'), 400)).toBe('title is required');
    expect(shownMessage(new ConflictError('Conflict — try again'), 409)).toBe(
      'Conflict — try again',
    );
    expect(shownMessage(new TypeError('secret detail'), 500)).toBe(INTERNAL_ERROR);
    expect(shownMessage('boom', 400)).toBe('error');
  });
});
