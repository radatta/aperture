import { describe, expect, it } from 'vitest';
import { userDueEpoch } from './dates';
import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
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
  });

  it('clips long titles and bodies', () => {
    const long = 'x'.repeat(500);
    expect(reminderCopy([cand({ title: long })]).title).toHaveLength(PUSH_TITLE_MAX);
    const batch = reminderCopy(Array.from({ length: 20 }, () => cand({ title: long })));
    expect(batch.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(batch.body.endsWith('…')).toBe(true);
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
