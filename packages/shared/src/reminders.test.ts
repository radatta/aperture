import { describe, expect, it } from 'vitest';
import { userDueEpoch } from './dates';
import {
  PUSH_BODY_MAX,
  PUSH_ENDPOINT_ERROR,
  PUSH_ENDPOINT_MAX,
  PUSH_KEY_MAX,
  PUSH_KEYS_ERROR,
  PUSH_LABEL_MAX,
  PUSH_TITLE_MAX,
  parsePushInput,
  planFireAt,
  pushEndpointOk,
  reminderCopy,
  reminderEnabled,
  reminderKind,
  reminderPayload,
  reminderTag,
  taskFireAt,
  taskPushPath,
} from './reminders';
import type { ReminderCandidate } from './reminders';
import type { Task } from './types';

const task = (over: Partial<Task>): Task =>
  ({ id: 't', status: 'backlog', deletedAt: null, dueDay: null, dueTime: null, ...over }) as Task;

const cand = (over: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  kind: 'timed',
  fireAt: 1_800_000_000_000,
  taskId: '01JTASK',
  title: 'Renew passport',
  dueTime: '14:00',
  ...over,
});

describe('taskFireAt', () => {
  it('a timed task fires at its due time, a day-only one at 09:00, in the user zone', () => {
    expect(taskFireAt(task({ dueDay: '2026-11-10', dueTime: '14:00' }), userDueEpoch)).toBe(
      Date.UTC(2026, 10, 10, 22, 0), // PST, UTC−8
    );
    expect(taskFireAt(task({ dueDay: '2026-07-10' }), userDueEpoch)).toBe(
      Date.UTC(2026, 6, 10, 16, 0), // PDT, UTC−7
    );
  });

  it('holds 09:00 across both DST switches', () => {
    expect(taskFireAt(task({ dueDay: '2026-03-08' }), userDueEpoch)).toBe(Date.UTC(2026, 2, 8, 16));
    expect(taskFireAt(task({ dueDay: '2026-11-01' }), userDueEpoch)).toBe(
      Date.UTC(2026, 10, 1, 17),
    );
  });

  it('never for a finished, tombstoned or undated task; errands and parts ping like any task', () => {
    const due = { dueDay: '2026-11-10', dueTime: '14:00' };
    expect(taskFireAt(task({ ...due, status: 'done' }), userDueEpoch)).toBeNull();
    expect(taskFireAt(task({ ...due, status: 'cancelled' }), userDueEpoch)).toBeNull();
    expect(taskFireAt(task({ ...due, deletedAt: 5 }), userDueEpoch)).toBeNull();
    expect(taskFireAt(task({}), userDueEpoch)).toBeNull();
    expect(
      taskFireAt(task({ ...due, place: 'safeway', parentId: 'p' }), userDueEpoch),
    ).not.toBeNull();
    expect(taskFireAt(task({ ...due, status: 'in_progress' }), userDueEpoch)).not.toBeNull();
  });
});

describe('planFireAt / reminderKind / reminderEnabled', () => {
  it('a plan fires at 09:00 on its day unless tombstoned', () => {
    expect(planFireAt({ day: '2026-11-10', deletedAt: null }, userDueEpoch)).toBe(
      Date.UTC(2026, 10, 10, 17),
    );
    expect(planFireAt({ day: '2026-11-10', deletedAt: 1 }, userDueEpoch)).toBeNull();
  });

  it('kinds follow the deadline', () => {
    expect(reminderKind({ dueDay: '2026-11-10', dueTime: '14:00' })).toBe('timed');
    expect(reminderKind({ dueDay: '2026-11-10', dueTime: null })).toBe('dueDay');
    expect(reminderKind({ dueDay: null, dueTime: null })).toBeNull();
  });

  it('each kind has its own switch; an absent one is on; a test always sends', () => {
    expect(reminderEnabled('timed', {})).toBe(true);
    expect(reminderEnabled('timed', { remindTimed: false })).toBe(false);
    expect(reminderEnabled('dueDay', { remindTimed: false })).toBe(true);
    expect(reminderEnabled('planned', { remindPlanned: false })).toBe(false);
    expect(
      reminderEnabled('test', { remindTimed: false, remindDueDay: false, remindPlanned: false }),
    ).toBe(true);
  });
});

describe('reminderCopy', () => {
  it('one reminder: the title, and why now', () => {
    expect(reminderCopy([cand()])).toEqual({ title: 'Renew passport', body: 'Due now · 2pm' });
    expect(reminderCopy([cand({ dueTime: '09:30' })]).body).toBe('Due now · 9:30am');
    expect(reminderCopy([cand({ kind: 'dueDay', dueTime: null })]).body).toBe('Due today');
    expect(reminderCopy([cand({ kind: 'planned', dueTime: null })]).body).toBe('Planned for today');
    expect(reminderCopy([cand({ kind: 'test', taskId: null, title: '' })])).toEqual({
      title: 'Aperture test',
      body: 'Reminders reach this device',
    });
    expect(reminderCopy([cand({ title: '   ' })]).title).toBe('Untitled task');
  });

  it('several in one tick batch into one notification', () => {
    const copy = reminderCopy([
      cand(),
      cand({ taskId: 'b', title: 'Call mom' }),
      cand({ title: 'Milk' }),
    ]);
    expect(copy).toEqual({ title: '3 reminders', body: 'Renew passport · Call mom · Milk' });
    // A Send test caught in the same tick reads as itself, not as an untitled task.
    expect(reminderCopy([cand(), cand({ kind: 'test', taskId: null, title: '' })]).body).toBe(
      'Renew passport · Aperture test',
    );
  });

  it('clips long titles and bodies', () => {
    const long = 'x'.repeat(500);
    expect(reminderCopy([cand({ title: long })]).title).toHaveLength(PUSH_TITLE_MAX);
    const batch = reminderCopy(Array.from({ length: 20 }, () => cand({ title: long })));
    expect(batch.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(batch.body.endsWith('…')).toBe(true);
  });

  it('clips by code points, never splitting an emoji in half', () => {
    const title = reminderCopy([cand({ title: `${'x'.repeat(PUSH_TITLE_MAX - 2)}😀😀😀` })]).title;
    expect(title).toBe(`${'x'.repeat(PUSH_TITLE_MAX - 2)}😀…`); // the old slice left half an emoji
  });

  it('refuses an empty tick', () => {
    expect(() => reminderCopy([])).toThrow();
  });
});

describe('reminderPayload', () => {
  it('is a declarative push with an absolute navigate onto the task', () => {
    expect(reminderPayload([cand()], 'https://aperture.example/')).toEqual({
      web_push: 8030,
      notification: {
        title: 'Renew passport',
        body: 'Due now · 2pm',
        navigate: 'https://aperture.example/tasks?lens=today&task=01JTASK&n=01JTASK',
        tag: '01JTASK',
        silent: false,
        lang: 'en-US',
      },
    });
  });

  it('a batch lands on Today, tagged by its minute; a test is tagged test', () => {
    const batch = [cand(), cand({ taskId: 'b' })];
    expect(reminderTag(batch)).toBe(`b${Math.floor(1_800_000_000_000 / 60_000)}`);
    expect(reminderPayload(batch, 'https://a.example').notification.navigate).toBe(
      `https://a.example/tasks?lens=today&n=${reminderTag(batch)}`,
    );
    expect(reminderTag([cand({ kind: 'test', taskId: null })])).toBe('test');
  });

  it('stays under the push size limit even for the largest batch', () => {
    const big = Array.from({ length: 50 }, (_, i) =>
      cand({ taskId: `t${i}`, title: '🙂'.repeat(200) }),
    );
    expect(() => reminderPayload(big, 'https://a.example')).not.toThrow();
  });

  it('builds the tap path with or without a task', () => {
    expect(taskPushPath('a b', 'x')).toBe('/tasks?lens=today&task=a%20b&n=x');
    expect(taskPushPath(null, 'b1')).toBe('/tasks?lens=today&n=b1');
  });
});

describe('pushEndpointOk', () => {
  it('admits the known push services over https', () => {
    expect(pushEndpointOk('https://web.push.apple.com/QGabc')).toBe(true);
    expect(pushEndpointOk('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushEndpointOk('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(pushEndpointOk('https://wns2-by3p.notify.windows.com/w/?token=abc')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of [
      'http://web.push.apple.com/x',
      'https://evil.example/x',
      'https://web.push.apple.com.evil.example/x',
      'https://evilweb.push.apple.com/x',
      'https://notify.windows.com/x',
      'https://evilnotify.windows.com/x',
      'https://user:pw@web.push.apple.com/x',
      'https://web.push.apple.com@evil.example/x',
      'https://web.push.apple.com:8443/x',
      'javascript:alert(1)',
      '',
      'nope',
    ])
      expect(pushEndpointOk(bad), bad).toBe(false);
  });
});

describe('parsePushInput', () => {
  const ok = {
    endpoint: 'https://web.push.apple.com/QGabc',
    keys: { p256dh: 'BPk-1', auth: 'au_2' },
  };

  it('admits a browser subscription and cleans its label', () => {
    expect(parsePushInput({ ...ok, label: '  iPhone \n ·   Safari ' })).toEqual({
      ...ok,
      label: 'iPhone · Safari',
    });
    expect(parsePushInput({ ...ok, label: 'x'.repeat(200) }).label).toHaveLength(PUSH_LABEL_MAX);
    expect(parsePushInput({ ...ok, label: '   ' }).label).toBe('This device');
    expect(parsePushInput({ ...ok, label: 7 }).label).toBe('This device');
  });

  it('refuses a bad endpoint, then bad keys', () => {
    for (const endpoint of [
      undefined,
      7,
      'https://evil.example/x',
      `${ok.endpoint}${'a'.repeat(PUSH_ENDPOINT_MAX)}`,
    ])
      expect(() => parsePushInput({ ...ok, endpoint }), String(endpoint)).toThrow(
        PUSH_ENDPOINT_ERROR,
      );
    expect(() => parsePushInput(null)).toThrow(PUSH_ENDPOINT_ERROR);
    for (const keys of [
      undefined,
      {},
      { p256dh: 'BPk', auth: '' },
      { p256dh: '', auth: 'au' },
      { p256dh: 'x'.repeat(PUSH_KEY_MAX + 1), auth: 'au' },
      { p256dh: 'not base64!', auth: 'au' },
      { p256dh: 'BPk', auth: 3 },
    ])
      expect(() => parsePushInput({ ...ok, keys }), JSON.stringify(keys)).toThrow(PUSH_KEYS_ERROR);
  });
});
