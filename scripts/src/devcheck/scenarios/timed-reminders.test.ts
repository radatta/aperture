import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DevPushDevice, DevPushStatus } from '../api';
import {
  CAUGHT_UP,
  droppedForKeys,
  e2eOutcome,
  laClock,
  pushKeys,
  RAN_OUT,
  RETRYING,
  stageFault,
} from './timed-reminders';

// The end-to-end step reads the poller's own words back (lambdas/src/push/dispatch.ts — scripts doesn't
// depend on lambdas): the strings below are what it writes for each answer Apple can give a never-issued
// endpoint. If dispatch's copy moves, these and e2eOutcome move with it.
const SINCE = 1_800_000_000_000;
const LABEL = 'Devcheck A n0nce';
const device = (over: Partial<DevPushDevice> = {}): DevPushDevice => ({
  id: 'A',
  label: LABEL,
  createdAt: SINCE,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
  ...over,
});
type Over = Partial<Omit<DevPushStatus, 'poller'>> & { poller?: Partial<DevPushStatus['poller']> };
const status = ({ poller, ...over }: Over): DevPushStatus => ({
  configured: true,
  vapidPublicKey: 'B',
  devices: [],
  removedDeviceIds: [],
  ...over,
  poller: { lastRunAt: SINCE, lastSentAt: null, lastError: null, lastErrorAt: null, ...poller },
});
const goneError = (code: number) =>
  `${LABEL} stopped accepting reminders (push service answered ${code}) — turn them on again on that device`;
const keptError = (code: number) =>
  `Last reminder didn't reach this device (push service answered ${code})`;

const C = 'Devcheck C n0nce';
const cDropped = `${C} stopped accepting reminders (its keys are invalid) — turn them on again on that device`;
const AT = SINCE + 30_000; // the tick's time

describe('e2eOutcome', () => {
  it('waits while no refusal is stamped since the reminder fell due', () => {
    expect(e2eOutcome(status({ devices: [device()] }), 'A', LABEL, SINCE)).toBeNull();
    const old = status({
      devices: [device({ lastError: keptError(400), lastErrorAt: SINCE - 60_000 })],
      poller: { lastError: goneError(410), lastErrorAt: SINCE - 60_000 },
    });
    expect(e2eOutcome(old, 'A', LABEL, SINCE)).toBeNull();
  });

  it('404 and 410: the poller deleted the device and named it — a pass, alone or beside C’s drop', () => {
    for (const code of [404, 410])
      for (const lastError of [
        goneError(code),
        `${goneError(code)} · ${cDropped}`,
        `${cDropped} · ${goneError(code)}`,
      ])
        expect(
          e2eOutcome(status({ poller: { lastError, lastErrorAt: AT } }), 'A', LABEL, SINCE),
        ).toEqual({ ok: true, how: `Apple answered ${code}: the poller deleted the device` });
  });

  it('400 and 403: the device stays, carrying the error — a pass', () => {
    for (const code of [400, 403])
      expect(
        e2eOutcome(
          status({
            devices: [device({ lastError: keptError(code), lastErrorAt: AT })],
            poller: { lastError: `${LABEL}: ${keptError(code)}`, lastErrorAt: AT },
          }),
          'A',
          LABEL,
          SINCE,
        ),
      ).toEqual({ ok: true, how: `Apple answered ${code}: the device carries the error` });
  });

  it('anything else a send can produce is a named failure', () => {
    const tick = { lastErrorAt: AT };
    for (const lastError of [
      "Last reminder didn't reach this device (push service answered 503)",
      "Last reminder didn't reach this device (timed out)",
      "Last reminder didn't reach this device (network error)",
      "Last reminder didn't reach this device (couldn't send: RangeError)",
    ])
      expect(
        e2eOutcome(
          status({ devices: [device({ lastError, lastErrorAt: AT })], poller: tick }),
          'A',
          LABEL,
          SINCE,
        ),
      ).toMatchObject({ ok: false });
    // Delivered?! Apple took a never-issued endpoint (only an acceptance moves lastSentAt).
    expect(
      e2eOutcome(
        status({ devices: [device({ lastOkAt: AT })], poller: { lastSentAt: AT } }),
        'A',
        LABEL,
        SINCE,
      ),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/accepted/) });
    // Gone without a 404/410, or gone because the user removed it.
    expect(
      e2eOutcome(status({ poller: { ...tick, lastError: cDropped } }), 'A', LABEL, SINCE),
    ).toMatchObject({
      ok: false,
    });
    expect(
      e2eOutcome(
        status({ removedDeviceIds: ['A'], poller: { ...tick, lastError: goneError(410) } }),
        'A',
        LABEL,
        SINCE,
      ),
    ).toMatchObject({ ok: false });
    // The test user's daily guard is shut.
    expect(
      e2eOutcome(
        status({
          devices: [device()],
          poller: {
            lastError: "Daily reminder limit (50) reached — the rest of today's were held back",
            lastErrorAt: SINCE + 1,
          },
        }),
        'A',
        LABEL,
        SINCE,
      ),
    ).toMatchObject({ ok: false, why: expect.stringMatching(/daily guard/) });
    // The stage can't sign at all: no key, a malformed one, or no APP_URL (dispatch.ts STAGE_ERROR).
    for (const lastError of [
      'No VAPID key on this stage — reminders are off',
      'VAPID private key is malformed — reminders are off',
      'This stage has no APP_URL (the VAPID sub) — reminders are off',
    ])
      expect(e2eOutcome(status({ poller: { lastError } }), 'A', LABEL, SINCE)).toMatchObject({
        ok: false,
        why: expect.stringMatching(/can't send/),
      });
  });

  it('a label with regex characters still matches only itself', () => {
    const odd = 'Devcheck (A) n0nce';
    const err = `${odd} stopped accepting reminders (push service answered 410) — turn them on again on that device`;
    const s = status({ poller: { lastError: err, lastErrorAt: AT } });
    expect(e2eOutcome(s, 'A', odd, SINCE)).toMatchObject({ ok: true });
    expect(e2eOutcome(s, 'A', 'Devcheck XAX n0nce', SINCE)).toMatchObject({ ok: false });
  });
});

describe('stageFault', () => {
  it('is any stage error, by its common ending — never a device’s', () => {
    expect(stageFault(status({ poller: { lastError: 'A new fault — reminders are off' } }))).toBe(
      true,
    );
    expect(stageFault(status({ poller: { lastError: cDropped } }))).toBe(false);
    expect(stageFault(status({}))).toBe(false);
  });
});

describe('droppedForKeys', () => {
  it('is the head of the poller’s line for a device whose keys no service takes', () => {
    expect(droppedForKeys(C)).toBe(cDropped.split(' — ')[0]);
  });
});

describe('the end-to-end task and keys', () => {
  it('laClock is the LA wall clock, 24-hour, so a task due this minute is in the next tick’s window', () => {
    expect(laClock(new Date('2026-11-04T22:05:59Z'))).toBe('14:05'); // PST
    expect(laClock(new Date('2026-07-04T07:00:00Z'))).toBe('00:00'); // PDT, midnight as 00
  });

  it('pushKeys is a P-256 point and a 16-octet secret, fresh each time', () => {
    const k = pushKeys();
    const point = Buffer.from(k.p256dh, 'base64url');
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    expect(Buffer.from(k.auth, 'base64url')).toHaveLength(16);
    // It's a real point: an ECDH against it works (what the poller's encrypt does first).
    const e = createECDH('prime256v1');
    e.generateKeys();
    expect(e.computeSecret(point)).toHaveLength(32);
    expect(pushKeys().p256dh).not.toBe(k.p256dh);
  });
});

// The retry chain reads N's error by these; push/deliver.ts writes it (scripts can't import lambdas), so a
// change to that copy fails here first.
describe('the retry chain’s copy', () => {
  const lead = "Last reminder didn't reach this device";
  it('matches what a network failure or a timeout writes at each step, and nothing else', () => {
    for (const why of ['network error', 'timed out']) {
      expect(RETRYING.test(`${lead} (${why}) — retrying`)).toBe(true);
      expect(RAN_OUT.test(`${lead} (${why}) after 4 tries`)).toBe(true);
      expect(CAUGHT_UP.test(`Couldn't deliver the catch-up for 1 missed reminder (${why})`)).toBe(
        true,
      );
    }
    expect(RETRYING.test(`${lead} (push service answered 503) — retrying`)).toBe(false);
    expect(RETRYING.test(`${lead} (network error)`)).toBe(false);
    expect(RAN_OUT.test(`${lead} (network error) after 3 tries`)).toBe(false);
    expect(
      CAUGHT_UP.test(`Couldn't deliver the catch-up for 2 missed reminders (network error)`),
    ).toBe(false);
  });
});
