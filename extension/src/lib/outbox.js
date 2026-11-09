// The background's outbox — pure queue operations over plain data (persisted in storage.local.outbox). One
// send in flight, first in first out: an entry waiting to retry holds those behind it (events are idempotent
// per id on the server, so a resent batch is harmless). Statuses per lambdas/src/index.ts ingestFailureStatus:
// 409, 429 and 5xx (and a network failure) retry; 401 pauses everything until the token changes; 413 splits;
// any other refusal is kept as failed and shown — never dropped silently.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).outbox = api;
})(globalThis, function () {
  'use strict';
  // packages/shared/src/sittings.ts: SITTING_EVENTS_PER_CALL, SITTING_CALL_BYTES, PAYLOAD_MAX.
  const MAX_EVENTS = 50;
  const MAX_CALL_BYTES = 256 * 1024;
  const EVENT_MAX = {
    snapshot: 64 * 1024,
    run: 96 * 1024,
    submit: 96 * 1024,
    submitDetails: 96 * 1024,
    note: 16 * 1024,
    timer: 1024,
    replay: 64 * 1024,
  };
  const QUEUE_MAX_ENTRIES = 2000;
  const QUEUE_MAX_BYTES = 5 * 1024 * 1024; // of storage.local's 10 MB
  const BACKOFF_MS = [5_000, 30_000, 60_000, 120_000, 300_000];

  const encoder = new TextEncoder();
  const bytes = (s) => encoder.encode(s).length;
  // What the server counts: the payload's JSON (a replay chunk's text).
  const eventBytes = (e) =>
    e.type === 'replay' ? bytes(e.events) : bytes(JSON.stringify(e.payload ?? null));
  const empty = () => ({ entries: [], paused: null });

  // Events → batches the server takes in one call; an event over its own cap is dropped (it would 400).
  function splitBatch(events) {
    const batches = [];
    let cur = [];
    let curBytes = 0;
    let dropped = 0;
    for (const e of events) {
      const b = eventBytes(e);
      if (b > (EVENT_MAX[e.type] ?? 0)) {
        dropped++;
        continue;
      }
      if (cur.length && (cur.length >= MAX_EVENTS || curBytes + b > MAX_CALL_BYTES)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(e);
      curBytes += b;
    }
    if (cur.length) batches.push(cur);
    return { batches, dropped };
  }

  const entryOf = (id, sittingId, slug, events, now) => ({
    id,
    sittingId,
    slug,
    events,
    bytes: events.reduce((n, e) => n + eventBytes(e), 0),
    tries: 0,
    nextAt: now,
    state: 'queued',
    lastStatus: null,
    lastError: null,
    createdAt: now,
  });

  // Over its caps, the queue sheds its oldest snapshot-only entries first; runs and submits are never shed.
  function enqueue(queue, entries) {
    const list = [...queue.entries, ...entries];
    let shed = 0;
    const total = () => list.reduce((n, e) => n + e.bytes, 0);
    while (list.length > QUEUE_MAX_ENTRIES || total() > QUEUE_MAX_BYTES) {
      const i = list.findIndex((e) => e.events.every((ev) => ev.type === 'snapshot'));
      if (i < 0) break;
      list.splice(i, 1);
      shed++;
    }
    return { queue: { ...queue, entries: list }, shed };
  }

  // The entry to send now, or how long until the head may go; null when there's nothing or it's paused.
  function next(queue, now) {
    if (queue.paused) return null;
    const head = queue.entries.find((e) => e.state === 'queued');
    if (!head) return null;
    return head.nextAt <= now ? { entry: head } : { wait: head.nextAt - now };
  }

  const retryable = (status) => status === 0 || status === 409 || status === 429 || status >= 500;
  // A send's outcome → the new queue and what happened ('sent' | 'retry' | 'paused' | 'split' | 'failed').
  function applyResult(queue, id, { status, error }, now) {
    const i = queue.entries.findIndex((e) => e.id === id);
    if (i < 0) return { queue, outcome: 'missing' };
    const entries = queue.entries.slice();
    const e = entries[i];
    if (status >= 200 && status < 300) {
      entries.splice(i, 1);
      return { queue: { ...queue, entries }, outcome: 'sent' };
    }
    if (status === 401) {
      entries[i] = { ...e, lastStatus: status, lastError: error || null };
      return { queue: { ...queue, entries, paused: 'auth' }, outcome: 'paused' };
    }
    if (retryable(status)) {
      const tries = e.tries + 1;
      entries[i] = {
        ...e,
        tries,
        nextAt: now + BACKOFF_MS[Math.min(tries, BACKOFF_MS.length) - 1],
        lastStatus: status,
        lastError: error || null,
      };
      return { queue: { ...queue, entries }, outcome: 'retry' };
    }
    if (status === 413 && e.events.length > 1) {
      const half = Math.ceil(e.events.length / 2);
      entries.splice(
        i,
        1,
        entryOf(`${e.id}.1`, e.sittingId, e.slug, e.events.slice(0, half), now),
        entryOf(`${e.id}.2`, e.sittingId, e.slug, e.events.slice(half), now),
      );
      return { queue: { ...queue, entries }, outcome: 'split' };
    }
    entries[i] = { ...e, state: 'failed', lastStatus: status, lastError: error || null };
    return { queue: { ...queue, entries }, outcome: 'failed' };
  }

  // Options → Retry now: failed entries go back in line and every wait ends; a token change unpauses.
  const retryNow = (queue, now) => ({
    paused: null,
    entries: queue.entries.map((e) => ({
      ...e,
      state: 'queued',
      nextAt: now,
      tries: e.state === 'failed' ? 0 : e.tries,
    })),
  });
  const unpause = (queue) => ({ ...queue, paused: null });
  const clearFailed = (queue) => ({
    ...queue,
    entries: queue.entries.filter((e) => e.state !== 'failed'),
  });
  const counts = (queue) => ({
    queued: queue.entries.filter((e) => e.state === 'queued').length,
    failed: queue.entries.filter((e) => e.state === 'failed').length,
    paused: queue.paused,
  });

  return {
    MAX_EVENTS,
    MAX_CALL_BYTES,
    EVENT_MAX,
    BACKOFF_MS,
    empty,
    eventBytes,
    splitBatch,
    entryOf,
    enqueue,
    next,
    applyResult,
    retryNow,
    unpause,
    clearFailed,
    counts,
    retryable,
  };
});
