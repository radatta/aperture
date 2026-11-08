import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { USER_TIME_ZONE, zonedEpoch } from '@aperture/shared';

// The Lambda runs in UTC; the container and the stub run in the user's zone, so the contract suite can't
// see a day bucketed by the runtime's clock. Pin the process to UTC, like the Lambda.
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

async function finishAt(day: string, hhmm: string) {
  const doc = new InMemoryDoc();
  let clock = zonedEpoch('2026-11-05', '09:00', USER_TIME_ZONE);
  const b = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
    userId: 'local',
    now: () => clock,
  });
  const t = await b.createTask({ title: 'Late one', estimateMin: 30, bufferMin: 0 });
  await b.transitionTask(t.id, 'in_progress');
  await b.setTaskActual(t.id, 40);
  clock = zonedEpoch(day, hhmm, USER_TIME_ZONE);
  await b.transitionTask(t.id, 'done');
  return b;
}

describe('getCalibration buckets a finish by the user’s day, not the Lambda’s', () => {
  it('is UTC here, so the case is real', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });

  // 21:30 PST on 2026-11-05 is 05:30 UTC on 2026-11-06: past midnight UTC, still the 5th for the user.
  it('a finish at 21:30 PST lands on that day', async () => {
    const b = await finishAt('2026-11-05', '21:30');
    const cal = await b.getCalibration({ from: '2026-11-05', to: '2026-11-05' });
    expect(cal.map((p) => p.day)).toEqual(['2026-11-05']);
  });

  // Before the day-start hour (4) it is still the previous day, in the user's zone.
  it('a finish at 02:00 PST on the 6th still counts for the 5th', async () => {
    const b = await finishAt('2026-11-06', '02:00');
    const cal = await b.getCalibration({ from: '2026-11-05', to: '2026-11-05' });
    expect(cal.map((p) => p.day)).toEqual(['2026-11-05']);
  });

  it('a morning finish is unchanged', async () => {
    const b = await finishAt('2026-11-05', '10:00');
    const cal = await b.getCalibration({ from: '2026-11-05', to: '2026-11-05' });
    expect(cal.map((p) => p.day)).toEqual(['2026-11-05']);
  });
});
