import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient, SettingsPatch } from './api';
import type { Area } from './areas';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TASK, UPLOAD_URL_TTL_MS } from './attachments';
import { TASK_NOTES_MAX, TASK_REFLECTION_MAX } from './taskNotes';
import { addDays, dayKeyInZone, USER_TIME_ZONE } from './dates';
import { fluxWeekStart } from './flux/history';
import { REP_NO_SPLIT_ERROR } from './split';
import { FUTURE_DAY_ERROR } from './machines';
import { SERIES_OFFSET_ERROR, SERIES_UNTIL_ERROR } from './recurrence';
import {
  PLACE_FINISHED_ERROR,
  PLACE_PART_ERROR,
  PLACE_TOKEN_PREFIX,
  placeUnknownError,
} from './places';
import { SCOPED_TOKEN_PREFIX, SCOPED_TOKENS_MAX } from './capture';
import {
  deriveFinanceView,
  FINANCE_REFRESH_COOLDOWN_MS,
  financeListRange,
  resolveRefundLinks,
} from './finance';
import { FIXTURE_INSTITUTION, FIXTURE_LINK_ACCOUNTS } from './financeFixtures';
import {
  PUSH_ENDPOINT_ERROR,
  PUSH_ENDPOINT_MAX,
  PUSH_KEY_MAX,
  PUSH_KEYS_ERROR,
  PUSH_LABEL_MAX,
  PUSH_NO_DEVICE_ERROR,
  PUSH_UNKNOWN_DEVICE_ERROR,
} from './reminders';
import type { SubscribePushInput } from './reminders';
import type { RecordFluxSetInput } from './api';
import { ulid } from './ulid';
import {
  LC_ROLL_UNLINKED_ERROR,
  SITTING_ACTIVE_ERROR,
  SITTING_ENDED_ERROR,
  SITTING_CAP_ERROR,
  SITTING_END_GRACE_MS,
  SITTING_END_SKEW_MS,
  SITTING_EVENTS_PER_CALL,
  SITTING_INGEST_WINDOW_MS,
  SITTING_MAX_EVENTS,
  SITTING_START_TIME_ERROR,
  sittingMetrics,
  DRAFT_LINES_MAX,
  REVIEW_LINE_MAX,
} from './sittings';
import type { SittingEventInput, SittingStartInput } from './sittings';

// A browser's push subscription as subscribePush receives it; override the endpoint per device.
const pushSub = (endpoint = 'https://web.push.apple.com/QGdev-1'): SubscribePushInput => ({
  endpoint,
  keys: { p256dh: 'BPk-p256dh-sample', auth: 'auth-sample' },
  label: 'iPhone · Safari',
});

// A finished Flux set as the stage hands it over; override what a test is about.
const fluxSet = (over: Partial<RecordFluxSetInput> = {}): RecordFluxSetInput => ({
  id: ulid(),
  day: '2026-10-20',
  exerciseId: 'cervical-rotation',
  kind: 'romReps',
  side: null,
  condition: null,
  count: 20,
  avgPeakDeg: 52.5,
  avgErrorDeg: null,
  rom: { pitch: 4, yaw: 110, roll: 6 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 240,
  completedAt: 1_700_000_000_000,
  repTaskId: null,
  stoppedEarly: false,
  planned: 10,
  ...over,
});

// A LeetCode sitting's Start as the extension sends it, and its events (LeetCode's shapes, minimized).
const LC_T0 = 1_700_000_000_000; // the suite's clock: 2023-11-14T22:13:20Z
const sittingStart = (over: Partial<SittingStartInput> = {}): SittingStartInput => ({
  clientSittingId: ulid(),
  problemSlug: 'two-sum',
  problemTitle: 'Two Sum',
  difficulty: 'Easy',
  topicTags: ['Array', 'Hash Table'],
  lang: 'python3',
  startedAt: LC_T0,
  tzOffsetMinutes: 300, // UTC-5 → 2023-11-14 17:13 local
  ...over,
});
const lcSnap = (code: string, at: number): SittingEventInput => ({
  id: ulid(),
  type: 'snapshot',
  at,
  payload: { code, lang: 11, questionId: 1 },
});
const lcJudged = (
  type: 'run' | 'submit',
  status: number,
  msg: string,
  at: number,
  passed: number,
  total: number,
): SittingEventInput => ({
  id: ulid(),
  type,
  at,
  payload: {
    request: { lang: 'python3', typed_code: 'print("x")' },
    result: { status_code: status, status_msg: msg, total_correct: passed, total_testcases: total },
  },
});
// A roll linked as the LeetCode roll, then a Start — the common opening.
async function startSitting(api: ApiClient, over: Partial<SittingStartInput> = {}) {
  const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
  await api.updateSettings({ leetcodeRollId: roll.id });
  return { ...(await api.lcSittingStart(sittingStart(over))), roll };
}

// ONE behavior suite, run against every ApiClient implementation — the in-memory stub, the in-process
// Lambda (BackendClient over an in-memory table), and any future transport. If the swap is faithful,
// all pass identically. `makeClient` is handed a clock so time-based behavior (heartbeat accrual) is
// deterministic; each test gets a fresh, empty client.
//
// NOT covered here: the gated Google Calendar methods (getCalendarBusy/insertCalendarEvent/…). Their
// behavior depends on external gateway state — connected accounts — that can't be established through
// the ApiClient interface (connect is a browser OAuth redirect, not a method), so a fair cross-impl
// comparison isn't possible in this suite. Parity is instead held by parallel per-impl tests with
// matching scenarios: lambdas/src/backend.calendar.test.ts and app/src/data/stubClient.calendar.test.ts.
// parseTask is out for the same reason (it rides a model gateway — Haiku in the Lambda, a heuristic in the
// stub): lambdas/src/backend.parse.test.ts and app/src/data/stubParse.test.ts.
export function runApiContract(
  label: string,
  makeClient: (now: () => number) => ApiClient | Promise<ApiClient>,
) {
  describe(`ApiClient contract — ${label}`, () => {
    let clock: number;
    let api: ApiClient;
    beforeEach(async () => {
      clock = 1_700_000_000_000;
      api = await makeClient(() => clock);
    });
    const advance = (ms: number) => {
      clock += ms;
    };
    // getDay refuses a day after the user's app day: a case that reads a 2026-08 day sets the clock to
    // that day first (20:00Z = early afternoon LA, well past any day start). The stub compares against
    // the runner's local day, which app/vitest.config.ts pins to the user's zone, as the Lambda reads it.
    const at = (day: string) => {
      clock = Date.parse(`${day}T20:00:00Z`);
    };

    it('logs: create is retrievable by its own day, and updates', async () => {
      const e = await api.createLogEntry('shipped it', '2026-08-04');
      expect(e.day).toBe('2026-08-04'); // bucketed by the client-supplied day, not a server-derived one
      const list = await api.listLogEntries(e.day);
      expect(list.map((x) => x.text)).toContain('shipped it');
      const updated = await api.updateLogEntry(e.id, 'shipped it, finally');
      expect(updated.text).toBe('shipped it, finally');
    });

    it('logs: a range read returns the days between, oldest first, and refuses a reversed range', async () => {
      const a = await api.createLogEntry('first', '2026-08-03');
      advance(1000);
      const b = await api.createLogEntry('second', '2026-08-04');
      advance(1000);
      const c = await api.createLogEntry('third', '2026-08-04');
      await api.createLogEntry('outside', '2026-08-06');
      const ids = (r: Parameters<ApiClient['listLogRange']>[0]) =>
        api.listLogRange(r).then((l) => l.map((e) => e.id));
      expect(await ids({ from: '2026-08-03', to: '2026-08-05' })).toEqual([a.id, b.id, c.id]);
      expect(await ids({ from: '2026-08-04', to: '2026-08-04' })).toEqual([b.id, c.id]);
      expect(await ids({ to: '2026-08-03' })).toEqual([a.id]); // an open bound reads to that end
      expect((await ids({})).length).toBe(4);
      await expect(api.listLogRange({ from: '2026-08-05', to: '2026-08-04' })).rejects.toThrow(
        'Invalid range',
      );
      await expect(api.listLogRange({ from: '2026-8-5' })).rejects.toThrow('Invalid day');
    });

    it('logs: deleteLogEntry tombstones an entry (listed no more; a second delete is a no-op)', async () => {
      const e = await api.createLogEntry('seeded', '2026-08-04');
      await api.deleteLogEntry(e.id);
      expect(await api.listLogEntries('2026-08-04')).toEqual([]);
      expect(await api.listLogRange({})).toEqual([]);
      await expect(api.deleteLogEntry(e.id)).resolves.toBeUndefined();
      await expect(api.deleteLogEntry('missing')).resolves.toBeUndefined();
    });

    it('day: peekDay reads the stored row and writes nothing (null before getDay creates it)', async () => {
      at('2026-08-04');
      expect(await api.peekDay('2026-08-04')).toBeNull();
      expect(await api.peekDay('2026-08-05')).toBeNull(); // a future day is a plain read, never refused
      await api.setDayIntent('2026-08-04', 'ship it');
      expect((await api.peekDay('2026-08-04'))?.intent).toBe('ship it');
      await expect(api.peekDay('nope')).rejects.toThrow('Invalid day');
    });

    it('logs: create takes a private flag, a text edit keeps it, and the toggle flips it both ways', async () => {
      const e = await api.createLogEntry('disk pw', '2026-08-04', { private: true });
      expect(e.private).toBe(true);
      expect((await api.listLogEntries(e.day)).find((x) => x.id === e.id)?.private).toBe(true);
      expect((await api.updateLogEntry(e.id, 'disk pw, rotated')).private).toBe(true);
      expect((await api.setLogEntryPrivate(e.id, false)).private).toBe(false);
      expect((await api.setLogEntryPrivate(e.id, true)).private).toBe(true);
      expect((await api.listLogEntries(e.day)).find((x) => x.id === e.id)).toMatchObject({
        private: true,
        text: 'disk pw, rotated',
      });
      // The export is the user's own download: a private entry keeps its text and flag there.
      expect((await api.exportData()).logEntries.find((x) => x.id === e.id)).toMatchObject({
        private: true,
        text: 'disk pw, rotated',
      });
      expect((await api.createLogEntry('plain', '2026-08-04')).private).toBe(false);
    });

    it('logs: a non-boolean private flag or an unknown id is refused and changes nothing', async () => {
      const e = await api.createLogEntry('plain', '2026-08-04');
      await expect(api.setLogEntryPrivate(e.id, 'yes' as never)).rejects.toThrow();
      await expect(
        api.createLogEntry('x', '2026-08-04', { private: 'true' as never }),
      ).rejects.toThrow();
      expect((await api.listLogEntries(e.day)).map((x) => x.text)).not.toContain('x');
      await expect(api.setLogEntryPrivate('01NOPE', true)).rejects.toThrow(/Not found/);
      const gone = await api.createLogEntry('deleted', '2026-08-04');
      await api.deleteLogEntry(gone.id);
      await expect(api.setLogEntryPrivate(gone.id, true)).rejects.toThrow(/Not found/);
      await expect(api.updateLogEntry(gone.id, 'back?')).rejects.toThrow(/Not found/);
      expect((await api.listLogEntries(e.day)).find((x) => x.id === e.id)?.private).toBe(false);
    });

    it('stories: create defaults empty S/A/R, lists updatedAt-desc, patches, and soft-deletes', async () => {
      const a = await api.createStory({
        title: 'Led the migration',
        competencyTags: ['leadership'],
      });
      // Empty S/A/R default to '' — a title-only stub is valid (start ugly, tighten later).
      expect(a.situation).toBe('');
      expect(a.action).toBe('');
      expect(a.result).toBe('');
      expect(a.competencyTags).toEqual(['leadership']);

      advance(1000);
      const b = await api.createStory({ title: 'Handled the outage' });
      expect(b.competencyTags).toEqual([]); // omitted → empty, not undefined

      // Newest-updated first.
      expect((await api.listStories()).map((s) => s.id)).toEqual([b.id, a.id]);

      // Patching the older one bumps updatedAt and moves it to the top.
      advance(1000);
      const patched = await api.updateStory(a.id, {
        situation: 'Prod was down',
        competencyTags: ['leadership', 'ownership'],
      });
      expect(patched.situation).toBe('Prod was down');
      expect(patched.competencyTags).toEqual(['leadership', 'ownership']);
      expect((await api.listStories()).map((s) => s.id)).toEqual([a.id, b.id]);

      // Soft-delete drops it from the list, and updating a deleted story throws for every impl.
      await api.deleteStory(b.id);
      expect((await api.listStories()).map((s) => s.id)).toEqual([a.id]);
      await expect(api.updateStory(b.id, { title: 'nope' })).rejects.toThrow();
    });

    it('attachments: presign→confirm lists the file, normalizes name/type, and soft-delete removes it', async () => {
      const task = await api.createTask({ title: 'has files' });
      const { attachment, uploadUrl } = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'shot.png',
        contentType: 'image/png',
        size: 1234,
      });
      expect(uploadUrl).toBeTruthy();
      expect(attachment.status).toBe('pending');
      expect(attachment.s3Key).toContain(task.id); // scoped by user + task, not the filename
      expect(attachment.s3Key).not.toContain('shot.png');

      // A pending row is not listed until the browser confirms the PUT.
      expect(await api.listAttachments(task.id)).toHaveLength(0);

      const ready = await api.confirmAttachment(attachment.id);
      expect(ready.status).toBe('ready');
      const list = await api.listAttachments(task.id);
      expect(list.map((a) => a.id)).toEqual([attachment.id]);
      expect(list[0]!.filename).toBe('shot.png');
      expect(list[0]!.contentType).toBe('image/png');

      // A download URL is mintable while ready; the no-arg list spans all tasks.
      expect(await api.getAttachmentDownloadUrl(attachment.id)).toBeTruthy();
      expect((await api.listAttachments()).map((a) => a.id)).toContain(attachment.id);

      // Name is sanitized (path separators → _) and an unusable type collapses to octet-stream.
      const messy = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'a/b\\c .png',
        contentType: 'not a type',
        size: 5,
      });
      expect(messy.attachment.filename).toBe('a_b_c .png');
      expect(messy.attachment.contentType).toBe('application/octet-stream');

      // Soft-delete drops it from the list, and minting/confirming a deleted one throws for every impl.
      await api.deleteAttachment(attachment.id);
      expect((await api.listAttachments(task.id)).map((a) => a.id)).not.toContain(attachment.id);
      await expect(api.getAttachmentDownloadUrl(attachment.id)).rejects.toThrow();
      await expect(api.confirmAttachment(attachment.id)).rejects.toThrow();
    });

    it('attachments: enforces the size cap, the per-task count cap, and expiry of pending rows', async () => {
      const task = await api.createTask({ title: 'capped' });
      await expect(
        api.createAttachmentUploadUrl({
          taskId: task.id,
          filename: 'big',
          contentType: 'application/pdf',
          size: ATTACHMENT_MAX_BYTES + 1,
        }),
      ).rejects.toThrow();

      // Fill the last-but-one slots with confirmed rows, then take the final slot with a PENDING row.
      for (let i = 0; i < ATTACHMENTS_PER_TASK - 1; i++) {
        const { attachment } = await api.createAttachmentUploadUrl({
          taskId: task.id,
          filename: `f${i}`,
          contentType: 'application/pdf',
          size: 10,
        });
        await api.confirmAttachment(attachment.id);
      }
      const { attachment: stale } = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'pending',
        contentType: 'application/pdf',
        size: 10,
      });
      // A fresh pending row still counts, so the cap is full.
      await expect(
        api.createAttachmentUploadUrl({
          taskId: task.id,
          filename: 'blocked',
          contentType: 'application/pdf',
          size: 10,
        }),
      ).rejects.toThrow();

      // Once its upload URL expires the pending row can never become ready, so it frees its slot...
      advance(UPLOAD_URL_TTL_MS + 1);
      const ok = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'now-fits',
        contentType: 'application/pdf',
        size: 10,
      });
      expect(ok.attachment.status).toBe('pending');
      // ...and confirming that expired row is rejected — otherwise it would resurrect a discounted slot
      // (cap bypass) and mark a byte-less object ready.
      await expect(api.confirmAttachment(stale.id)).rejects.toThrow();
    });

    it('tasks: the lock freezes at start, survives a later estimate edit, and is the calibration point', async () => {
      const t = await api.createTask({ title: 'Task A', estimateMin: 30, bufferMin: 8 });
      expect((await api.listBacklog()).map((x) => x.id)).toContain(t.id);

      await api.setTaskEstimate(t.id, 30, 8);
      const started = await api.transitionTask(t.id, 'in_progress');
      expect(started.estimateLockedMin).toBe(30); // frozen at start
      expect(started.startedAt).not.toBeNull();

      // Rescoping mid-task moves the working estimate only.
      const rescoped = await api.setTaskEstimate(t.id, 99, 0);
      expect(rescoped.estimateMin).toBe(99);
      expect(rescoped.estimateLockedMin).toBe(30);

      await api.setTaskActual(t.id, 45);
      const done = await api.transitionTask(t.id, 'done');
      expect(done.status).toBe('done');
      expect(done.completedAt).not.toBeNull();
      await expect(api.setTaskEstimate(t.id, 10, 0)).rejects.toThrow(); // a finished estimate is history

      const cal = await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
      const point = cal.find((p) => p.taskId === t.id);
      expect(point?.estimateLockedMin).toBe(30);
      expect(point?.actualAccruedMin).toBe(45);
    });

    it('tasks: a done split makes a parent that takes the title and lock; the original is Part 1', async () => {
      const t = await api.createTask({ title: 'Big thing', estimateMin: 60, bufferMin: 0 });
      await api.transitionTask(t.id, 'in_progress');
      const { parent, original, followUp } = await api.splitTask(t.id, {
        finish: 'done',
        title: 'Big thing, part 1',
        actualMin: 40,
        followUp: { title: ' Big thing, part 2 ', estimateMin: 50 },
      });
      expect(original).toMatchObject({
        status: 'done',
        title: 'Big thing, part 1',
        actualAccruedMin: 40,
        estimateLockedMin: 60,
      });
      expect(followUp).toMatchObject({
        title: 'Big thing, part 2',
        status: 'backlog', // the original was never on a plan
        estimateMin: 50,
        estimateLockedMin: null, // a new prediction, never the frozen value
        parentId: parent.id,
      });
      expect(original).toMatchObject({ id: t.id, parentId: parent.id }); // same task: its sessions stay
      expect(parent).toMatchObject({
        title: 'Big thing',
        status: 'backlog',
        estimateMin: null,
        estimateLockedMin: 60, // the whole job's baseline predates every part
        parentId: null,
      });
      expect((await api.listTasks()).map((x) => x.id)).toEqual(
        expect.arrayContaining([parent.id, original.id, followUp.id]),
      );
    });

    it('tasks: a keep split on a planned task leaves it open and plans the follow-up on its day', async () => {
      const t = await api.createTask({ title: 'Essay', estimateMin: 90, bufferMin: 0 });
      await api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 90, order: 0 });
      await api.transitionTask(t.id, 'planned');
      await api.transitionTask(t.id, 'in_progress');
      const { original, followUp } = await api.splitTask(t.id, {
        finish: 'keep',
        title: 'Essay: draft',
        estimateMin: 45,
        followUp: { title: 'Essay: edit', estimateMin: 30, bufferMin: 5 },
      });
      expect(original).toMatchObject({
        status: 'in_progress',
        title: 'Essay: draft',
        estimateMin: 45,
        estimateLockedMin: 90,
      });
      expect(followUp).toMatchObject({
        status: 'planned',
        parentId: original.parentId,
        bufferMin: 5,
      });
      const rows = await api.listPlansForDay('2026-08-04');
      expect(rows.find((p) => p.taskId === followUp.id)).toMatchObject({
        plannedMinutes: 35,
        order: 1,
      });
      // The rescoped original's row shrinks to its new size, so the day counts the job once.
      expect(rows.find((p) => p.taskId === t.id)?.plannedMinutes).toBe(45);
    });

    it('tasks: splitting an unstarted task makes an unlocked parent; each part calibrates alone', async () => {
      const t = await api.createTask({
        title: 'Reading',
        estimateMin: 60,
        bufferMin: 0,
        dueDay: '2026-10-13',
      });
      await expect(
        api.splitTask(t.id, { finish: 'done', followUp: { title: 'x', estimateMin: null } }),
      ).rejects.toThrow(); // done needs a started task
      const { parent, original, followUp } = await api.splitTask(t.id, {
        finish: 'keep',
        estimateMin: 30,
        followUp: { title: 'Reading, ch. 2', estimateMin: 30 },
      });
      expect(original).toMatchObject({ status: 'backlog', title: 'Part 1' }); // the default title
      expect(followUp).toMatchObject({ status: 'backlog', parentId: parent.id });
      expect(parent.estimateLockedMin).toBeNull();
      // An untimed day is a deadline: the parent's only (parts.md D7).
      expect(parent.dueDay).toBe('2026-10-13');
      expect([original.dueDay, followUp.dueDay]).toEqual([null, null]);
      for (const id of [original.id, followUp.id]) {
        await api.transitionTask(id, 'in_progress');
        await api.setTaskActual(id, 25);
        await api.transitionTask(id, 'done');
      }
      const ids = (await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' })).map(
        (p) => p.taskId,
      );
      expect(ids).toEqual(expect.arrayContaining([original.id, followUp.id]));
    });

    it('tasks: splitting a part adds a sibling under the same parent; a parent can’t be split', async () => {
      const a = await api.createTask({ title: 'Pset', estimateMin: 60, bufferMin: 0 });
      await api.transitionTask(a.id, 'in_progress');
      const { parent, followUp: b } = await api.splitTask(a.id, {
        finish: 'done',
        actualMin: 40,
        followUp: { title: 'Pset, 2', estimateMin: 40 },
      });
      const { parent: same, followUp: c } = await api.splitTask(b.id, {
        finish: 'keep',
        title: 'Pset, 2a',
        followUp: { title: 'Pset, 3', estimateMin: 20 },
      });
      expect(same.id).toBe(parent.id);
      expect(c.parentId).toBe(parent.id); // one level: a sibling, never a grandchild
      expect((await api.getTask(b.id))?.title).toBe('Pset, 2a');
      await expect(
        api.splitTask(a.id, { finish: 'keep', followUp: { title: 'y', estimateMin: null } }),
      ).rejects.toThrow(); // a finished part can't be split
      await expect(
        api.splitTask(parent.id, { finish: 'keep', followUp: { title: 'y', estimateMin: null } }),
      ).rejects.toThrow(/add a part/);
      await expect(
        api.splitTask(b.id, {
          finish: 'keep',
          parentTitle: 'renamed',
          followUp: { title: 'z', estimateMin: null },
        }),
      ).rejects.toThrow(/already has its title/);
    });

    it('tasks: a typed title on a standalone split is what’s stored, for the parent and both parts', async () => {
      const t = await api.createTask({ title: 'Essay', estimateMin: 60 });
      const { parent, original, followUp } = await api.splitTask(t.id, {
        finish: 'keep',
        parentTitle: ' The essay ',
        title: ' outline ',
        followUp: { title: ' draft ', estimateMin: 30 },
      });
      expect([parent.title, original.title, followUp.title]).toEqual([
        'The essay',
        'outline',
        'draft',
      ]);
      expect((await api.getTask(t.id))?.title).toBe('outline');
    });

    it('tasks: a done split on a planned task shrinks its row to the actual and plans the rest', async () => {
      const t = await api.createTask({ title: 'Pset', estimateMin: 60, bufferMin: 15 });
      await api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 75, order: 0 });
      await api.transitionTask(t.id, 'planned');
      await api.transitionTask(t.id, 'in_progress');
      const { followUp } = await api.splitTask(t.id, {
        finish: 'done',
        actualMin: 40,
        followUp: { title: 'Pset, rest', estimateMin: 35 },
      });
      const rows = await api.listPlansForDay('2026-08-04');
      expect(rows.find((p) => p.taskId === t.id)?.plannedMinutes).toBe(40); // what the part took
      expect(rows.find((p) => p.taskId === followUp.id)?.plannedMinutes).toBe(35);
    });

    it('tasks: a backlog original with an old plan row splits its rest into the backlog', async () => {
      const t = await api.createTask({ title: 'Rolled back', estimateMin: 60 });
      await api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 60, order: 0 });
      await api.transitionTask(t.id, 'planned');
      await api.transitionTask(t.id, 'in_progress');
      await api.transitionTask(t.id, 'backlog'); // rollover: the row stays as history
      const { followUp } = await api.splitTask(t.id, {
        finish: 'keep',
        followUp: { title: 'Rolled back, rest', estimateMin: 30 },
      });
      expect(followUp.status).toBe('backlog');
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.taskId)).not.toContain(
        followUp.id,
      );
    });

    it('tasks: a split rejects negative or non-number minutes before any write', async () => {
      const t = await api.createTask({ title: 'Numbers', estimateMin: 30 });
      await api.transitionTask(t.id, 'in_progress');
      const before = (await api.listTasks()).length;
      const bad = [
        { finish: 'done' as const, actualMin: -5, followUp: { title: 'r', estimateMin: 5 } },
        { finish: 'keep' as const, estimateMin: -1, followUp: { title: 'r', estimateMin: 5 } },
        { finish: 'keep' as const, followUp: { title: 'r', estimateMin: -5 } },
        {
          finish: 'done' as const,
          actualMin: Number.NaN,
          followUp: { title: 'r', estimateMin: 5 },
        },
      ];
      for (const input of bad) await expect(api.splitTask(t.id, input)).rejects.toThrow(/minutes/);
      expect((await api.listTasks()).length).toBe(before);
      expect(await api.getTask(t.id)).toMatchObject({ status: 'in_progress', actualAccruedMin: 0 });
    });

    it('tasks: a split with an empty follow-up title writes nothing', async () => {
      const t = await api.createTask({ title: 'keep me', estimateMin: 30 });
      await api.transitionTask(t.id, 'in_progress');
      const before = (await api.listTasks()).length;
      await expect(
        api.splitTask(t.id, {
          finish: 'done',
          actualMin: 5,
          followUp: { title: '  ', estimateMin: null },
        }),
      ).rejects.toThrow();
      expect((await api.listTasks()).length).toBe(before);
      expect((await api.getTask(t.id))?.status).toBe('in_progress');
    });

    it('parts: the first part clears the parent’s estimate, and a planned parent’s row moves to it', async () => {
      const p = await api.createTask({ title: 'P2', estimateMin: 120, bufferMin: 10 });
      await api.upsertPlan({ taskId: p.id, day: '2026-08-04', plannedMinutes: 130, order: 0 });
      await api.transitionTask(p.id, 'planned');
      const [a, b] = await api.createTasks([
        { title: 'read', estimateMin: 45, parentId: p.id },
        { title: 'draft', estimateMin: 60, parentId: p.id },
      ]);
      expect(await api.getTask(p.id)).toMatchObject({
        status: 'backlog',
        estimateMin: null,
        bufferMin: null,
      });
      const rows = await api.listPlansForDay('2026-08-04');
      expect(rows.map((r) => r.taskId)).toEqual([a!.id]); // only the first part takes the spot
      expect(rows[0]!.plannedMinutes).toBe(45);
      expect(await api.getTask(a!.id)).toMatchObject({ status: 'planned', parentId: p.id });
      expect(await api.getTask(b!.id)).toMatchObject({ status: 'backlog', parentId: p.id });
    });

    it('parts: the first part to start freezes the parent’s lock at Σ parts, once', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', estimateMin: 45, parentId: p.id });
      const b = await api.createTask({ title: 'b', estimateMin: 60, parentId: p.id });
      expect((await api.getTask(p.id))?.estimateLockedMin).toBeNull();
      await api.transitionTask(a.id, 'in_progress');
      expect((await api.getTask(p.id))?.estimateLockedMin).toBe(105);
      await api.setTaskEstimate(b.id, 90, null); // rescoping later never moves the baseline
      await api.transitionTask(b.id, 'in_progress');
      expect((await api.getTask(p.id))?.estimateLockedMin).toBe(105);
    });

    it('parts: done is refused while a part is open, then stamps Σ and is a calibration point', async () => {
      const p = await api.createTask({ title: 'P2' });
      // Parts list oldest first; separate creates land on separate instants (the clock is frozen here).
      const a = await api.createTask({ title: 'Part 1', estimateMin: 45, parentId: p.id });
      advance(1000);
      const b = await api.createTask({ title: 'Part 2', estimateMin: 60, parentId: p.id });
      advance(1000);
      const c = await api.createTask({ title: 'Part 3', estimateMin: 30, parentId: p.id });
      await api.transitionTask(a.id, 'in_progress');
      await api.setTaskActual(a.id, 50);
      await api.transitionTask(a.id, 'done');
      await expect(api.transitionTask(p.id, 'done')).rejects.toThrow(
        'Part 2 and Part 3 aren’t finished — complete, drop or delete them first',
      );
      await api.transitionTask(b.id, 'in_progress');
      await api.setTaskActual(b.id, 70);
      await api.transitionTask(b.id, 'done');
      await api.transitionTask(c.id, 'cancelled'); // dropped counts as dealt with
      const done = await api.transitionTask(p.id, 'done');
      expect(done).toMatchObject({ status: 'done', actualAccruedMin: 120, estimateLockedMin: 135 });
      const cal = await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
      expect(cal.map((x) => x.taskId)).toEqual(expect.arrayContaining([p.id, a.id, b.id]));
      expect(cal.map((x) => x.taskId)).not.toContain(c.id);
      // The rollup says how many parts it covers — the ones not dropped, the card's 2/2 — so the
      // headline can skip it.
      expect(cal.find((x) => x.taskId === p.id)?.parts).toBe(2);
      expect(cal.find((x) => x.taskId === a.id)?.parts).toBe(0);
    });

    it('parts: cancelling the parent drops its open parts; a done part stays as history', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', parentId: p.id, estimateMin: 30 });
      const b = await api.createTask({ title: 'b', parentId: p.id });
      await api.transitionTask(a.id, 'in_progress');
      await api.setTaskActual(a.id, 30);
      await api.transitionTask(a.id, 'done');
      expect(await api.transitionTask(p.id, 'cancelled')).toMatchObject({ status: 'cancelled' });
      expect((await api.getTask(a.id))?.status).toBe('done');
      expect((await api.getTask(b.id))?.status).toBe('cancelled');
    });

    it('parts: deleting the parent deletes every part with its plans; dropping a part touches nothing else', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', estimateMin: 30, parentId: p.id });
      const b = await api.createTask({ title: 'b', parentId: p.id });
      await api.upsertPlan({ taskId: a.id, day: '2026-08-04', plannedMinutes: 30, order: 0 });
      await api.transitionTask(a.id, 'planned');
      await api.transitionTask(b.id, 'cancelled');
      expect(await api.getTask(a.id)).toMatchObject({ status: 'planned', parentId: p.id });
      expect((await api.getTask(p.id))?.status).toBe('backlog');
      await api.deleteTask(p.id);
      expect(await api.getTask(p.id)).toBeNull();
      expect(await api.getTask(a.id)).toBeNull();
      expect(await api.getTask(b.id)).toBeNull();
      expect(await api.listPlansForDay('2026-08-04')).toHaveLength(0);
      await api.deleteTask(p.id); // idempotent
    });

    it('parts: a parent is never planned, started, estimated or given an actual of its own', async () => {
      const p = await api.createTask({ title: 'P2' });
      await api.createTask({ title: 'a', parentId: p.id });
      await expect(
        api.upsertPlan({ taskId: p.id, day: '2026-08-04', plannedMinutes: 30, order: 0 }),
      ).rejects.toThrow(/plan its parts/);
      await expect(api.transitionTask(p.id, 'in_progress')).rejects.toThrow(/start a part/);
      await expect(api.transitionTask(p.id, 'planned')).rejects.toThrow(/plan its parts/);
      await expect(api.setTaskEstimate(p.id, 30, null)).rejects.toThrow(/sum of its parts/);
      await expect(api.setTaskActual(p.id, 30)).rejects.toThrow(/sum of its parts/);
    });

    it('parts: one level both ways, and a task already worked on can’t become a parent', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', parentId: p.id });
      const x = await api.createTask({ title: 'x' });
      await expect(api.createTask({ title: 'deep', parentId: a.id })).rejects.toThrow(/one level/);
      await expect(api.setTaskParent(p.id, x.id)).rejects.toThrow(/one level/);
      const worked = await api.createTask({ title: 'worked', estimateMin: 30 });
      await api.transitionTask(worked.id, 'in_progress');
      await expect(api.createTask({ title: 'p', parentId: worked.id })).rejects.toThrow(/split/);
      await expect(api.createTask({ title: 'p', parentId: 'nope' })).rejects.toThrow();
      // createTasks checks every input before writing any.
      const before = (await api.listTasks()).length;
      await expect(
        api.createTasks([
          { title: 'ok', parentId: x.id },
          { title: 'bad', parentId: a.id },
        ]),
      ).rejects.toThrow(/one level/);
      expect((await api.listTasks()).length).toBe(before);
      expect((await api.getTask(x.id))?.estimateMin).toBeNull();
    });

    it('parts: setTaskParent attaches (a started task freezes the lock) and detaches', async () => {
      const p = await api.createTask({ title: 'P2', estimateMin: 90 });
      const a = await api.createTask({ title: 'a', estimateMin: 40 });
      await api.transitionTask(a.id, 'in_progress');
      expect(await api.setTaskParent(a.id, p.id)).toMatchObject({
        parentId: p.id,
        status: 'in_progress',
      });
      expect(await api.getTask(p.id)).toMatchObject({ estimateMin: null, estimateLockedMin: 40 });
      expect((await api.setTaskParent(a.id, null)).parentId).toBeNull();
      await expect(api.setTaskParent(a.id, a.id)).rejects.toThrow(/itself/);
      const data = await api.exportData();
      expect(data.tasks.find((t) => t.id === a.id)?.parentId).toBeNull();
    });

    it('parts: a task whose last part goes is plain again — its lock goes with them', async () => {
      const p = await api.createTask({ title: 'P2', estimateMin: 90 });
      const a = await api.createTask({ title: 'a', estimateMin: 40 });
      await api.transitionTask(a.id, 'in_progress');
      await api.setTaskParent(a.id, p.id);
      expect((await api.getTask(p.id))?.estimateLockedMin).toBe(40);
      await api.setTaskParent(a.id, null);
      expect((await api.getTask(p.id))?.estimateLockedMin).toBeNull();
      // Started later on its own, it freezes its own baseline, not its old parts'.
      await api.setTaskEstimate(p.id, 90, null);
      expect((await api.transitionTask(p.id, 'in_progress')).estimateLockedMin).toBe(90);
      // Deleting the last part does the same.
      const q = await api.createTask({ title: 'Q' });
      const b = await api.createTask({ title: 'b', estimateMin: 20, parentId: q.id });
      await api.transitionTask(b.id, 'in_progress');
      expect((await api.getTask(q.id))?.estimateLockedMin).toBe(20);
      await api.deleteTask(b.id);
      expect((await api.getTask(q.id))?.estimateLockedMin).toBeNull();
    });

    it('parts: a roll rep or a recurring occurrence can’t take parts', async () => {
      const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 30 });
      const { task: rep } = await api.pickRollToday(roll.id, '2026-08-04');
      await expect(api.createTask({ title: 'p', parentId: rep.id })).rejects.toThrow(
        /one rep of a repeating thing/,
      );
    });

    it('parts: a roll rep or a recurring occurrence can’t be split — no parent is minted', async () => {
      at('2026-08-04');
      const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 30 });
      const { task: rep } = await api.pickRollToday(roll.id, '2026-08-04');
      await api.upsertSeries({
        title: 'Daily standup',
        categoryId: null,
        defaultEstimateMin: 15,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      await api.getDay('2026-08-04');
      const occurrence = (await api.listTasks()).find((t) => t.seriesId);
      expect(occurrence).toBeDefined();
      const before = (await api.listTasks()).length;
      const plans = await api.listPlansForDay('2026-08-04');
      for (const t of [rep, occurrence!])
        await expect(
          api.splitTask(t.id, { finish: 'keep', followUp: { title: 'rest', estimateMin: null } }),
        ).rejects.toThrow(REP_NO_SPLIT_ERROR);
      // Refused before any write: no parent, no follow-up, no plan row.
      expect(await api.listTasks()).toHaveLength(before);
      expect(await api.listPlansForDay('2026-08-04')).toEqual(plans);
      // A roll-tagged part can't be made through the API any more; split.test.ts covers one from before.
    });

    it('parts: with every part dropped the parent can’t be marked done — it’s dropped instead', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', estimateMin: 60, parentId: p.id });
      await api.transitionTask(a.id, 'in_progress');
      await api.transitionTask(a.id, 'cancelled');
      await expect(api.transitionTask(p.id, 'done')).rejects.toThrow(/drop it instead/);
      expect((await api.transitionTask(p.id, 'cancelled')).status).toBe('cancelled');
    });

    it('parts: splitting a started, unscoped task leaves the parent unscored — a later start adds no hindsight baseline', async () => {
      const t = await api.createTask({ title: 'Unscoped' });
      await api.transitionTask(t.id, 'in_progress');
      const { parent, followUp } = await api.splitTask(t.id, {
        finish: 'keep',
        estimateMin: 30,
        followUp: { title: 'rest', estimateMin: 60 },
      });
      expect(parent.estimateLockedMin).toBeNull();
      advance(1000);
      await api.transitionTask(followUp.id, 'in_progress');
      expect((await api.getTask(parent.id))?.estimateLockedMin).toBeNull();
    });

    it('parts: the first start is the only freeze — a restart or a re-attach after scoping adds no hindsight baseline', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', parentId: p.id });
      advance(1000);
      const b = await api.createTask({ title: 'b', parentId: p.id });
      await api.transitionTask(a.id, 'in_progress'); // nothing sized yet: no baseline
      await api.setTaskEstimate(a.id, 30, 0);
      await api.setTaskEstimate(b.id, 60, 0);
      await api.transitionTask(a.id, 'backlog'); // rollover
      await api.transitionTask(a.id, 'in_progress');
      await api.setTaskParent(a.id, p.id); // already its part
      expect((await api.getTask(p.id))?.estimateLockedMin).toBeNull();
    });

    it('parts: export carries parentId', async () => {
      const p = await api.createTask({ title: 'P2' });
      const a = await api.createTask({ title: 'a', parentId: p.id });
      const data = await api.exportData();
      expect(data.tasks.find((t) => t.id === a.id)?.parentId).toBe(p.id);
    });

    it('tasks: createTasks creates every input as an unlocked backlog task, in paste order, with fields', async () => {
      const created = await api.createTasks([
        { title: 'first', estimateMin: 30, dueDay: '2026-09-25' },
        { title: 'second', categoryId: null },
        { title: 'third' },
      ]);
      expect(created.map((t) => t.title)).toEqual(['first', 'second', 'third']);
      expect(created.every((t) => t.status === 'backlog' && t.estimateLockedMin === null)).toBe(
        true,
      );
      expect(created[0]!.estimateMin).toBe(30);
      expect(created[0]!.dueDay).toBe('2026-09-25'); // dueDay from input round-trips
      // One createdAt stamp for the batch → they sort together, newest-first, in paste order.
      expect(created.every((t) => t.createdAt === created[0]!.createdAt)).toBe(true);
      const backlog = (await api.listBacklog()).filter((t) =>
        ['first', 'second', 'third'].includes(t.title),
      );
      expect(backlog.map((t) => t.title)).toEqual(['first', 'second', 'third']);
    });

    it('tasks: createTasks with no inputs writes nothing', async () => {
      expect(await api.createTasks([])).toEqual([]);
      expect(await api.listTasks()).toHaveLength(0);
    });

    it('tasks: delete tombstones the task with its plans + attachments, and is idempotent', async () => {
      const task = await api.createTask({ title: 'doomed', estimateMin: 30, bufferMin: 0 });
      // Plans on two different days — the cascade must reach every day, not just one.
      const plan1 = await api.upsertPlan({
        taskId: task.id,
        day: '2026-08-04',
        plannedMinutes: 30,
        order: 1,
      });
      const plan2 = await api.upsertPlan({
        taskId: task.id,
        day: '2026-08-05',
        plannedMinutes: 15,
        order: 1,
      });
      // One confirmed (ready) attachment and one still pending — both metadata rows must tombstone.
      const { attachment } = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        size: 100,
      });
      await api.confirmAttachment(attachment.id);
      const { attachment: pending } = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'wip.png',
        contentType: 'image/png',
        size: 50,
      });

      await api.deleteTask(task.id);

      // Gone from every list + direct read.
      expect((await api.listTasks()).map((x) => x.id)).not.toContain(task.id);
      expect((await api.listBacklog()).map((x) => x.id)).not.toContain(task.id);
      expect(await api.getTask(task.id)).toBeNull();
      // Its plan rows (every day) and attachment metadata are tombstoned too.
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).not.toContain(plan1.id);
      expect((await api.listPlansForDay('2026-08-05')).map((p) => p.id)).not.toContain(plan2.id);
      expect(await api.listAttachments(task.id)).toHaveLength(0);
      expect((await api.listAttachments()).map((a) => a.id)).not.toContain(attachment.id);
      await expect(api.getAttachmentDownloadUrl(attachment.id)).rejects.toThrow();
      // The pending row is gone too — confirming it now must fail (tombstoned).
      await expect(api.confirmAttachment(pending.id)).rejects.toThrow();
      // Excluded from the export.
      const data = await api.exportData();
      expect(data.tasks.map((t) => t.id)).not.toContain(task.id);
      expect(data.plans.map((p) => p.id)).not.toContain(plan1.id);
      expect(data.plans.map((p) => p.id)).not.toContain(plan2.id);
      expect(data.attachments.map((a) => a.id)).not.toContain(attachment.id);
      // A tombstoned task can't be transitioned, and a second delete is a no-op.
      await expect(api.transitionTask(task.id, 'in_progress')).rejects.toThrow();
      await expect(api.deleteTask(task.id)).resolves.toBeUndefined();
    });

    it('tasks: due day defaults null, is settable at any status without touching the lock, and clears', async () => {
      const t = await api.createTask({ title: 'has a deadline' });
      expect(t.dueDay).toBeNull(); // created undated

      const dated = await api.setTaskDueDay(t.id, '2026-08-07');
      expect(dated.dueDay).toBe('2026-08-07');
      expect((await api.getTask(t.id))?.dueDay).toBe('2026-08-07'); // survives read-back

      // Settable after work starts, and it never touches the frozen estimate baseline.
      await api.setTaskEstimate(t.id, 30, 0);
      const started = await api.transitionTask(t.id, 'in_progress');
      expect(started.estimateLockedMin).toBe(30);
      const moved = await api.setTaskDueDay(t.id, '2026-08-09');
      expect(moved.dueDay).toBe('2026-08-09');
      expect(moved.estimateLockedMin).toBe(30); // deadline change ≠ scope change

      const cleared = await api.setTaskDueDay(t.id, null);
      expect(cleared.dueDay).toBeNull();
      expect((await api.listTasks()).find((x) => x.id === t.id)?.dueDay).toBeNull();
    });

    it('tasks: due time defaults null, sets with the day, keeps across a day move, clears with the day', async () => {
      const t = await api.createTask({ title: 'timed' });
      expect(t.dueTime).toBeNull();
      expect(t.gcalSyncError).toBeNull();

      const timed = await api.setTaskDue(t.id, { dueDay: '2026-08-07', dueTime: '16:00' });
      expect(timed).toMatchObject({ dueDay: '2026-08-07', dueTime: '16:00' });
      expect((await api.getTask(t.id))?.dueTime).toBe('16:00'); // survives read-back

      // Omitted time = keep it (both the object form and the day-only back-compat method).
      expect(await api.setTaskDue(t.id, { dueDay: '2026-08-08' })).toMatchObject({
        dueDay: '2026-08-08',
        dueTime: '16:00',
      });
      expect((await api.setTaskDueDay(t.id, '2026-08-09')).dueTime).toBe('16:00');
      // An explicit null clears just the time.
      expect(await api.setTaskDue(t.id, { dueDay: '2026-08-09', dueTime: null })).toMatchObject({
        dueDay: '2026-08-09',
        dueTime: null,
      });

      // Never touches the lock; clearing the day clears the time.
      await api.setTaskDue(t.id, { dueDay: '2026-08-09', dueTime: '09:30' });
      await api.setTaskEstimate(t.id, 30, 0);
      await api.transitionTask(t.id, 'in_progress');
      const moved = await api.setTaskDue(t.id, { dueDay: '2026-08-10', dueTime: '10:00' });
      expect(moved.estimateLockedMin).toBe(30);
      expect(await api.setTaskDueDay(t.id, null)).toMatchObject({ dueDay: null, dueTime: null });
    });

    it('tasks: due time is validated and needs a day — a bad write changes nothing', async () => {
      const t = await api.createTask({ title: 'strict', dueDay: '2026-08-07', dueTime: '08:00' });
      expect(t.dueTime).toBe('08:00');
      await expect(api.setTaskDue(t.id, { dueDay: '2026-08-07', dueTime: '8:00' })).rejects.toThrow(
        /dueTime/,
      );
      await expect(api.setTaskDue(t.id, { dueDay: null, dueTime: '08:00' })).rejects.toThrow(
        /requires dueDay/,
      );
      await expect(api.createTask({ title: 'no day', dueTime: '08:00' })).rejects.toThrow(
        /requires dueDay/,
      );
      expect((await api.getTask(t.id))?.dueTime).toBe('08:00');
      // createTasks carries it, and one bad row writes none.
      const made = await api.createTasks([{ title: 'a', dueDay: '2026-08-07', dueTime: '23:59' }]);
      expect(made[0]!.dueTime).toBe('23:59');
      const before = (await api.listTasks()).length;
      await expect(
        api.createTasks([
          { title: 'ok' },
          { title: 'bad', dueDay: '2026-08-07', dueTime: '24:00' },
        ]),
      ).rejects.toThrow(/dueTime/);
      expect((await api.listTasks()).length).toBe(before);
    });

    it('tasks: split carries the due time to the follow-up', async () => {
      const t = await api.createTask({
        title: 'pset',
        estimateMin: 30,
        dueDay: '2026-08-07',
        dueTime: '17:00',
      });
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskActual(t.id, 20);
      const { followUp } = await api.splitTask(t.id, {
        finish: 'done',
        followUp: { title: 'pset, part 2', estimateMin: null },
      });
      expect(followUp).toMatchObject({ dueDay: '2026-08-07', dueTime: '17:00' });
      // Part 1 keeps its time too (when its block ends); the parent holds the real deadline.
      expect(await api.getTask(t.id)).toMatchObject({ dueDay: '2026-08-07', dueTime: '17:00' });
      expect(await api.getTask(followUp.parentId!)).toMatchObject({
        dueDay: '2026-08-07',
        dueTime: '17:00',
      });
    });

    it('tasks: title renames at any status, trims, rejects empty, and never touches the lock', async () => {
      const t = await api.createTask({ title: 'draft name', estimateMin: 30, bufferMin: 0 });

      const renamed = await api.setTaskTitle(t.id, '  Real name  ');
      expect(renamed.title).toBe('Real name'); // trimmed
      expect((await api.getTask(t.id))?.title).toBe('Real name'); // survives read-back

      // Rename after work starts, and it never touches the frozen estimate baseline.
      const started = await api.transitionTask(t.id, 'in_progress');
      expect(started.estimateLockedMin).toBe(30);
      const again = await api.setTaskTitle(t.id, 'Renamed mid-flight');
      expect(again.title).toBe('Renamed mid-flight');
      expect(again.estimateLockedMin).toBe(30); // rename ≠ scope change

      await expect(api.setTaskTitle(t.id, '   ')).rejects.toThrow(); // empty/whitespace rejected
    });

    it('tasks: notes default null, trim, set at any status without touching the lock, and clear', async () => {
      const t = await api.createTask({ title: 'with context', estimateMin: 30, bufferMin: 0 });
      expect(t.notes).toBeNull();
      expect((await api.createTask({ title: 'blank', notes: '  \n ' })).notes).toBeNull();
      expect((await api.createTask({ title: 'noted', notes: ' ch. 4\n' })).notes).toBe('ch. 4');

      const set = await api.setTaskNotes(t.id, '  **q6** hint\n- use the lemma  ');
      expect(set.notes).toBe('**q6** hint\n- use the lemma'); // trimmed, inner newlines kept
      expect((await api.getTask(t.id))?.notes).toBe('**q6** hint\n- use the lemma');

      const started = await api.transitionTask(t.id, 'in_progress');
      expect(started.estimateLockedMin).toBe(30);
      const mid = await api.setTaskNotes(t.id, 'mid-flight');
      expect(mid.notes).toBe('mid-flight');
      expect(mid.estimateLockedMin).toBe(30); // notes ≠ scope change
      await api.setTaskActual(t.id, 30);
      const done = await api.transitionTask(t.id, 'done');
      expect((await api.setTaskNotes(done.id, 'after the fact')).notes).toBe('after the fact');

      expect((await api.setTaskNotes(t.id, 'a\r\nb\rc')).notes).toBe('a\nb\nc'); // CRLF → LF
      // A call that lost its second argument (JSON has no undefined) is an error, never a silent clear.
      const setMissing = api.setTaskNotes as (id: string) => Promise<unknown>;
      await expect(setMissing(t.id)).rejects.toThrow();
      expect((await api.getTask(t.id))?.notes).toBe('a\nb\nc');

      expect((await api.setTaskNotes(t.id, null)).notes).toBeNull();
      await api.setTaskNotes(t.id, 'back');
      expect((await api.setTaskNotes(t.id, '')).notes).toBeNull();
      expect((await api.listTasks()).find((x) => x.id === t.id)?.notes).toBeNull();
    });

    it('tasks: notes cap at TASK_NOTES_MAX on set, create, and createTasks (whole batch)', async () => {
      const t = await api.createTask({ title: 'capped', notes: 'keep me' });
      const max = 'x'.repeat(TASK_NOTES_MAX);
      expect((await api.setTaskNotes(t.id, max)).notes).toHaveLength(TASK_NOTES_MAX);
      await api.setTaskNotes(t.id, 'keep me');
      await expect(api.setTaskNotes(t.id, `${max}y`)).rejects.toThrow();
      expect((await api.getTask(t.id))?.notes).toBe('keep me'); // the rejected write changed nothing

      await expect(api.createTask({ title: 'too long', notes: `${max}y` })).rejects.toThrow();
      await expect(
        api.createTasks([{ title: 'fine' }, { title: 'too long', notes: `${max}y` }]),
      ).rejects.toThrow();
      const titles = (await api.listTasks()).map((x) => x.title);
      expect(titles).not.toContain('too long');
      expect(titles).not.toContain('fine'); // one bad line creates nothing
    });

    it('tasks: split carries notes to the follow-up, and export includes them', async () => {
      const t = await api.createTask({
        title: 'Big thing',
        estimateMin: 60,
        notes: 'links + context',
      });
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskActual(t.id, 40);
      const { followUp } = await api.splitTask(t.id, {
        finish: 'done',
        followUp: { title: 'Big thing, part 2', estimateMin: null },
      });
      expect(followUp.notes).toBe('links + context');
      const data = await api.exportData();
      expect(data.tasks.find((x) => x.id === t.id)?.notes).toBe('links + context');
    });

    it('tasks: reflection saves with the actual, edits and clears at any status, never touches the lock, and rides export and the calibration point', async () => {
      const t = await api.createTask({ title: 'Pset', estimateMin: 30, bufferMin: 0 });
      expect(t.reflection).toBeNull();
      await api.transitionTask(t.id, 'in_progress');
      const saved = await api.setTaskActual(t.id, 45, '  Should have **outlined first**\r\n  ');
      expect(saved.actualAccruedMin).toBe(45);
      expect(saved.reflection).toBe('Should have **outlined first**'); // trimmed, CRLF → LF
      const done = await api.transitionTask(t.id, 'done');
      expect(done.reflection).toBe('Should have **outlined first**');
      expect(done.estimateLockedMin).toBe(30);

      const edited = await api.setTaskReflection(t.id, 'Outline first next time');
      expect(edited.reflection).toBe('Outline first next time');
      expect(edited.estimateLockedMin).toBe(30); // a reflection ≠ scope change
      expect((await api.getTask(t.id))?.reflection).toBe('Outline first next time');
      expect((await api.listTasks()).find((x) => x.id === t.id)?.reflection).toBe(
        'Outline first next time',
      );
      const point = (await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' })).find(
        (p) => p.taskId === t.id,
      );
      expect(point?.reflection).toBe('Outline first next time');
      expect((await api.exportData()).tasks.find((x) => x.id === t.id)?.reflection).toBe(
        'Outline first next time',
      );

      // An open task takes one too (any status), and a missing argument is an error, never a clear.
      const open = await api.createTask({ title: 'open' });
      expect((await api.setTaskReflection(open.id, 'early thought')).reflection).toBe(
        'early thought',
      );
      const setMissing = api.setTaskReflection as (id: string) => Promise<unknown>;
      await expect(setMissing(t.id)).rejects.toThrow();
      expect((await api.getTask(t.id))?.reflection).toBe('Outline first next time');

      // Over the cap rejects and writes nothing — on the edit, and on the actual it rides with.
      const max = 'x'.repeat(TASK_REFLECTION_MAX);
      expect((await api.setTaskReflection(t.id, max)).reflection).toHaveLength(TASK_REFLECTION_MAX);
      await api.setTaskReflection(t.id, 'keep me');
      await expect(api.setTaskReflection(t.id, `${max}y`)).rejects.toThrow();
      await expect(api.setTaskActual(t.id, 99, `${max}y`)).rejects.toThrow();
      const after = await api.getTask(t.id);
      expect(after?.reflection).toBe('keep me');
      expect(after?.actualAccruedMin).toBe(45); // the rejected actual changed nothing

      expect((await api.setTaskReflection(t.id, null)).reflection).toBeNull();
      await api.setTaskReflection(t.id, 'back');
      expect((await api.setTaskReflection(t.id, '  ')).reflection).toBeNull();
    });

    it('tasks: a two-argument setTaskActual keeps the reflection, null clears it, and split starts the new rows null', async () => {
      const t = await api.createTask({ title: 'Lab', estimateMin: 20, bufferMin: 0 });
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskActual(t.id, 20, 'went fine');
      expect((await api.setTaskActual(t.id, 25)).reflection).toBe('went fine'); // older caller: kept
      expect((await api.setTaskActual(t.id, 25, null)).reflection).toBeNull();

      const big = await api.createTask({ title: 'Essay', estimateMin: 60, bufferMin: 0 });
      await api.transitionTask(big.id, 'in_progress');
      await api.setTaskActual(big.id, 40, 'the intro took forever');
      const { parent, original, followUp } = await api.splitTask(big.id, {
        finish: 'done',
        followUp: { title: 'Essay, part 2', estimateMin: 30 },
      });
      expect(original.reflection).toBe('the intro took forever'); // the finished work keeps its own
      expect(followUp.reflection).toBeNull(); // new work
      expect(parent.reflection).toBeNull();
    });

    it('sessions: several run at once, a task dedups, and work time accrues to the task', async () => {
      const a = await api.startSession({
        taskId: null,
        categoryId: null,
        kind: 'work',
        label: 'CC: a',
        day: '2026-08-04',
      });
      await api.startSession({
        taskId: null,
        categoryId: null,
        kind: 'work',
        label: 'CC: b',
        day: '2026-08-04',
      });
      expect(await api.listRunningSessions()).toHaveLength(2);

      const task = await api.createTask({ title: 'Focused work' });
      const s1 = await api.startSession({
        taskId: task.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      const s2 = await api.startSession({
        taskId: task.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      expect(s2.id).toBe(s1.id); // dedup: one live timer per task

      advance(2 * 60_000); // two minutes of work
      await api.heartbeatSession(s1.id);
      await api.stopSession(s1.id, 'completed');
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(2);

      // Stopping removes it from the running set; the ad-hoc ones stay.
      expect((await api.listRunningSessions()).map((s) => s.label).sort()).toEqual([
        'CC: a',
        'CC: b',
      ]);
      void a;
    });

    it('sessions: a stop onto a finished task completes with its minutes but adds none to the task', async () => {
      // Mark done from the editor stops the timer first; this is the server's half for MCP and other devices.
      const task = await api.createTask({ title: 'Finished while timed', estimateMin: 30 });
      await api.transitionTask(task.id, 'in_progress');
      const s = await api.startSession({
        taskId: task.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      await api.setTaskActual(task.id, 10);
      await api.transitionTask(task.id, 'done');
      advance(5 * 60_000);
      const stopped = await api.stopSession(s.id, 'completed');
      expect(stopped.status).toBe('completed');
      expect(stopped.activeMinutes).toBe(5); // history keeps the time
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(10); // the typed actual stands

      // Cancelled is finished too; keep on a stale timer takes the same guard.
      const dropped = await api.createTask({ title: 'Dropped while timed' });
      await api.transitionTask(dropped.id, 'in_progress');
      const s2 = await api.startSession({
        taskId: dropped.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      await api.transitionTask(dropped.id, 'cancelled');
      advance(3 * 60_000);
      await api.heartbeatSession(s2.id);
      expect((await api.resolveStaleSession(s2.id, 'keep')).status).toBe('completed');
      expect((await api.getTask(dropped.id))?.actualAccruedMin).toBe(0);
    });

    it('sessions: a stop with capMin credits at most that much past the last beat; a bad cap is refused', async () => {
      const task = await api.createTask({ title: 'Sat on done', estimateMin: 30 });
      const start = () =>
        api.startSession({ taskId: task.id, categoryId: null, kind: 'work', day: '2026-08-04' });
      // Beat at 2 min, then 30 min of nothing (a block that reached its target, or a locked phone).
      const s1 = await start();
      advance(2 * 60_000);
      await api.heartbeatSession(s1.id);
      advance(30 * 60_000);
      await expect(api.stopSession(s1.id, 'completed', { capMin: -1 })).rejects.toThrow(/capMin/);
      expect((await api.listRunningSessions()).map((s) => s.id)).toContain(s1.id); // still running
      expect((await api.stopSession(s1.id, 'completed', { capMin: 3 })).activeMinutes).toBe(5);
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(5);

      const s2 = await start(); // a paused stop: the pause beat already captured the work
      advance(2 * 60_000);
      await api.heartbeatSession(s2.id);
      advance(30 * 60_000);
      expect((await api.stopSession(s2.id, 'completed', { capMin: 0 })).activeMinutes).toBe(2);
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(7);

      const s3 = await start(); // no cap (older JS): everything since the beat, as before
      advance(2 * 60_000);
      await api.heartbeatSession(s3.id);
      advance(30 * 60_000);
      expect((await api.stopSession(s3.id, 'completed')).activeMinutes).toBe(32);
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(39);
    });

    it('sessions: Again credits what was left to the target, not the wait, and the row keeps the new target', async () => {
      const task = await api.createTask({ title: 'One more block', estimateMin: 30 });
      const s = await api.startSession({
        taskId: task.id,
        categoryId: null,
        kind: 'work',
        day: '2026-08-04',
      });
      advance(2 * 60_000);
      await api.heartbeatSession(s.id);
      advance(30 * 60_000);
      await expect(api.extendSession(s.id, { capMin: -1 })).rejects.toThrow(/capMin/);
      expect(await api.extendSession(s.id, { capMin: 3 })).toMatchObject({
        activeMinutes: 5,
        blocks: 2,
      });
      expect((await api.listRunningSessions()).find((x) => x.id === s.id)?.blocks).toBe(2); // a reload's read
      advance(60_000); // the new block counts from Again
      expect((await api.stopSession(s.id, 'completed')).activeMinutes).toBe(6);
      expect((await api.getTask(task.id))?.actualAccruedMin).toBe(6);
    });

    it('plans: soft-delete removes them from the day', async () => {
      const task = await api.createTask({ title: 'Planned' });
      const plan = await api.upsertPlan({
        taskId: task.id,
        day: '2026-08-04',
        plannedMinutes: 30,
        order: 1,
      });
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).toContain(plan.id);
      await api.removePlan(plan.id);
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).not.toContain(plan.id);
    });

    it('plans: a second insert for one task and day returns the existing row; an id write still edits it; a removed row can be re-added', async () => {
      const task = await api.createTask({ title: 'Planned' });
      const other = await api.createTask({ title: 'Neighbour' });
      const row = { taskId: task.id, day: '2026-08-04', plannedMinutes: 30, order: 0 };
      const first = await api.upsertPlan(row);
      const again = await api.upsertPlan({ ...row, plannedMinutes: 60, order: 2 });
      expect(again).toEqual(first); // untouched: no resize, no reorder
      await api.upsertPlan({ ...row, taskId: other.id, order: 1 });
      const rows = () => api.listPlansForDay('2026-08-04');
      expect((await rows()).filter((p) => p.taskId === task.id)).toHaveLength(1);
      // A day apart is another row; an id write edits in place.
      await api.upsertPlan({ ...row, day: '2026-08-05' });
      expect(
        (await api.listPlansForDay('2026-08-05')).filter((p) => p.taskId === task.id),
      ).toHaveLength(1);
      const edited = await api.upsertPlan({ ...row, id: first.id, plannedMinutes: 45 });
      expect(edited.id).toBe(first.id);
      expect((await rows()).filter((p) => p.taskId === task.id)).toEqual([
        expect.objectContaining({ id: first.id, plannedMinutes: 45 }),
      ]);
      expect((await rows()).find((p) => p.taskId === other.id)).toMatchObject({
        plannedMinutes: 30,
        order: 1,
      });
      await api.removePlan(first.id);
      const readded = await api.upsertPlan(row);
      expect(readded.id).not.toBe(first.id);
      expect((await rows()).filter((p) => p.taskId === task.id)).toEqual([
        expect.objectContaining({ id: readded.id, plannedMinutes: 30 }),
      ]);
    });

    it('habits: check is idempotent per day and uncheck clears it', async () => {
      const h = await api.upsertHabit({ name: 'Read', categoryId: null, cadencePerWeek: 5 });
      const c1 = await api.checkHabit(h.id, '2026-08-04');
      const c2 = await api.checkHabit(h.id, '2026-08-04');
      expect(c2.id).toBe(c1.id); // one per (habit, day)
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toHaveLength(1);
      await api.uncheckHabit(h.id, '2026-08-04');
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toHaveLength(0);
      // Unchecking again, or a day never checked, is a no-op; a re-check is exactly one again.
      await api.uncheckHabit(h.id, '2026-08-04');
      await api.uncheckHabit(h.id, '2026-08-02');
      const c3 = await api.checkHabit(h.id, '2026-08-04');
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toEqual([c3]);
      expect(await api.listHabitChecks({ from: '2026-08-07', to: '2026-08-01' })).toEqual([]); // reversed: empty, never an error
    });

    it('rolls: upsert lists, archive flags, and category-delete reassigns', async () => {
      const r = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 30 });
      expect(r.active).toBe(true);
      expect((await api.listRolls()).map((x) => x.id)).toContain(r.id);

      // Edit via id (rename + estimate), then archive — archived stays in the list, flagged inactive.
      const renamed = await api.upsertRoll({
        id: r.id,
        name: 'LeetCode daily',
        categoryId: null,
        estimateMin: 45,
      });
      expect(renamed.name).toBe('LeetCode daily');
      expect(renamed.estimateMin).toBe(45);
      const archived = await api.upsertRoll({
        id: r.id,
        name: renamed.name,
        categoryId: null,
        estimateMin: 45,
        active: false,
      });
      expect(archived.active).toBe(false);
      expect((await api.listRolls()).find((x) => x.id === r.id)?.active).toBe(false);

      // A roll's category is reassigned when that category is deleted (like tasks/habits/series).
      const cat = await api.upsertCategory({ label: 'Learning', isWork: true });
      const target = await api.upsertCategory({ label: 'Other', isWork: true });
      const tagged = await api.upsertRoll({ name: 'Study', categoryId: cat.id, estimateMin: 20 });
      await api.deleteCategory(cat.id, target.id);
      expect((await api.listRolls()).find((x) => x.id === tagged.id)?.categoryId).toBe(target.id);

      // The created roll rides the export.
      expect((await api.exportData()).rolls.map((x) => x.id)).toContain(tagged.id);
    });

    it('rolls: picking creates a planned rep on the plan, dedups per day, and re-picks after done', async () => {
      const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 30 });

      // Pick for a day → a planned rep task tagged with the roll, appended to that day's plan.
      const first = await api.pickRollToday(roll.id, '2026-08-04');
      expect(first.task.rollId).toBe(roll.id);
      expect(first.task.status).toBe('planned');
      expect(first.task.estimateMin).toBe(30); // inherits the roll's estimate
      expect(first.plan.plannedMinutes).toBe(30);
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).toContain(first.plan.id);

      // Picking the same roll again the same day reuses the open rep — one task, one plan row.
      const again = await api.pickRollToday(roll.id, '2026-08-04');
      expect(again.task.id).toBe(first.task.id);
      expect(again.plan.id).toBe(first.plan.id);
      expect(await api.listPlansForDay('2026-08-04')).toHaveLength(1);

      // Picking on the NEXT day while the rep is still open re-plans the SAME task onto that day.
      const nextDay = await api.pickRollToday(roll.id, '2026-08-05');
      expect(nextDay.task.id).toBe(first.task.id);
      expect((await api.listPlansForDay('2026-08-05')).map((p) => p.taskId)).toContain(
        first.task.id,
      );

      // Once the rep is done, picking again spawns a FRESH task (a second rep is honest).
      await api.transitionTask(first.task.id, 'in_progress');
      await api.setTaskActual(first.task.id, 30);
      await api.transitionTask(first.task.id, 'done');
      const fresh = await api.pickRollToday(roll.id, '2026-08-05');
      expect(fresh.task.id).not.toBe(first.task.id);
      expect(fresh.task.status).toBe('planned');
    });

    it('ideas: triage moves an idea between status buckets', async () => {
      const idea = await api.createIdea('a thought');
      expect((await api.listIdeas('open')).map((i) => i.id)).toContain(idea.id);
      await api.triageIdea(idea.id, 'triaged');
      expect((await api.listIdeas('open')).map((i) => i.id)).not.toContain(idea.id);
      expect((await api.listIdeas('triaged')).map((i) => i.id)).toContain(idea.id);
    });

    it('day: getDay materializes due recurrence exactly once', async () => {
      at('2026-08-05');
      await api.upsertSeries({
        title: 'Daily standup',
        categoryId: null,
        defaultEstimateMin: 15,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      const day = await api.getDay('2026-08-04');
      expect(day.date).toBe('2026-08-04');

      const plans1 = await api.listPlansForDay('2026-08-04');
      expect(plans1).toHaveLength(1);
      const task = await api.getTask(plans1[0]!.taskId);
      expect(task?.title).toBe('Daily standup');
      expect(task?.status).toBe('planned');

      await api.getDay('2026-08-04'); // again → no duplicate occurrence
      expect(await api.listPlansForDay('2026-08-04')).toHaveLength(1);

      // Next day: a fresh occurrence is planned, and it supersedes the undone one — dropped, not
      // piled into backlog.
      await api.getDay('2026-08-05');
      expect((await api.getTask(task!.id))?.status).toBe('cancelled');
      const plans2 = await api.listPlansForDay('2026-08-05');
      expect(plans2).toHaveLength(1);
      expect(plans2[0]!.taskId).not.toBe(task!.id);
      expect((await api.getTask(plans2[0]!.taskId))?.status).toBe('planned');
    });

    it('series: unplanning an occurrence never respawns it; “+ Today” brings the same one back', async () => {
      await api.upsertSeries({
        title: 'Weekly report',
        categoryId: null,
        defaultEstimateMin: 60,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      at('2026-08-04');
      await api.getDay('2026-08-04');
      const [plan] = await api.listPlansForDay('2026-08-04');
      const occurrences = async () => (await api.listTasks()).filter((t) => t.seriesId);
      expect((await occurrences()).map((t) => t.seriesDay)).toEqual(['2026-08-04']);

      // Unplan: the row goes, the sweep sends the task to backlog — and getDay spawns no copy.
      await api.removePlan(plan!.id);
      await api.getDay('2026-08-04');
      await api.getDay('2026-08-04');
      expect(await api.listPlansForDay('2026-08-04')).toHaveLength(0);
      expect((await api.getTask(plan!.taskId))?.status).toBe('backlog');
      expect(await occurrences()).toHaveLength(1);

      // "+ Today" plans the same task again; still the one occurrence.
      await api.upsertPlan({
        taskId: plan!.taskId,
        day: '2026-08-04',
        plannedMinutes: 60,
        order: 1,
      });
      await api.transitionTask(plan!.taskId, 'planned');
      await api.getDay('2026-08-04');
      const plans = await api.listPlansForDay('2026-08-04');
      expect(plans.map((p) => p.taskId)).toEqual([plan!.taskId]);
      expect(await occurrences()).toHaveLength(1);
    });

    it('series: a due offset dates each occurrence from its day, untimed; a legacy series spawns undated', async () => {
      const dated = await api.upsertSeries({
        title: 'Weekly report',
        categoryId: null,
        defaultEstimateMin: 60,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
        dueOffsetDays: 1,
      });
      expect(dated).toMatchObject({ dueOffsetDays: 1, until: null });
      const sameDay = await api.upsertSeries({
        title: 'Quiz',
        categoryId: null,
        defaultEstimateMin: 20,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
        dueOffsetDays: 0,
      });
      const legacy = await api.upsertSeries({
        title: 'Standup',
        categoryId: null,
        defaultEstimateMin: 15,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      expect(legacy).toMatchObject({ dueOffsetDays: null, until: null });
      at('2026-08-31');
      await api.getDay('2026-08-31');
      const byTitle = Object.fromEntries((await api.listTasks()).map((t) => [t.title, t]));
      expect(byTitle['Weekly report']).toMatchObject({
        seriesId: dated.id,
        seriesDay: '2026-08-31',
        dueDay: '2026-09-01',
        dueTime: null,
        status: 'planned',
      });
      expect(byTitle['Quiz']).toMatchObject({ seriesId: sameDay.id, dueDay: '2026-08-31' });
      expect(byTitle['Standup']).toMatchObject({ seriesId: legacy.id, dueDay: null });
      expect(await api.listPlansForDay('2026-08-31')).toHaveLength(3);
    });

    it('series: an occurrence moved onto another due day is its own deliverable — that day still spawns', async () => {
      // Identity is (series, day), not the plan row (recurring.md D4): report 3, replanned onto
      // next Tuesday, doesn't stand in for report 4's — both show, each with its own due date.
      const s = await api.upsertSeries({
        title: 'Weekly report',
        categoryId: null,
        defaultEstimateMin: 60,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
        dueOffsetDays: 1,
      });
      at('2026-08-04');
      await api.getDay('2026-08-04');
      const [plan] = await api.listPlansForDay('2026-08-04');
      await api.removePlan(plan!.id);
      await api.upsertPlan({
        taskId: plan!.taskId,
        day: '2026-08-05',
        plannedMinutes: 60,
        order: 1,
      });
      at('2026-08-05');
      await api.getDay('2026-08-05');
      const rows = await api.listPlansForDay('2026-08-05');
      expect(rows).toHaveLength(2);
      const tasks = (await api.listTasks()).filter((t) => t.seriesId === s.id);
      expect(tasks.map((t) => [t.seriesDay, t.dueDay, t.status]).sort()).toEqual([
        ['2026-08-04', '2026-08-05', 'planned'],
        ['2026-08-05', '2026-08-06', 'planned'],
      ]);
    });

    it('series: nothing spawns after until; the row stays active', async () => {
      const s = await api.upsertSeries({
        title: 'Weekly report',
        categoryId: null,
        defaultEstimateMin: 60,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
        until: '2026-08-04',
      });
      at('2026-08-04');
      await api.getDay('2026-08-04');
      expect(await api.listPlansForDay('2026-08-04')).toHaveLength(1);
      at('2026-08-05');
      await api.getDay('2026-08-05');
      expect(await api.listPlansForDay('2026-08-05')).toHaveLength(0);
      expect((await api.listTasks()).filter((t) => t.seriesId === s.id)).toHaveLength(1);
      expect((await api.listSeries()).find((x) => x.id === s.id)).toMatchObject({
        active: true,
        until: '2026-08-04',
      });
    });

    it('series: a bad cadence is refused before any write, on create and on edit', async () => {
      const input = {
        title: 'Weekly report',
        categoryId: null,
        defaultEstimateMin: 60,
        rule: { kind: 'daily' } as const,
        anchorDate: '2026-08-01',
      };
      await expect(api.upsertSeries({ ...input, dueOffsetDays: -1 })).rejects.toThrow(
        SERIES_OFFSET_ERROR,
      );
      await expect(api.upsertSeries({ ...input, until: '2026-2-5' })).rejects.toThrow(
        SERIES_UNTIL_ERROR,
      );
      expect(await api.listSeries()).toHaveLength(0);
      const s = await api.upsertSeries(input);
      await expect(api.upsertSeries({ ...input, id: s.id, dueOffsetDays: 1.5 })).rejects.toThrow(
        SERIES_OFFSET_ERROR,
      );
      expect((await api.listSeries())[0]).toMatchObject({ dueOffsetDays: null });
    });

    it('series: deleteSeries tombstones the template; its occurrences stay; idempotent', async () => {
      const s = await api.upsertSeries({
        title: 'Weekly report',
        categoryId: null,
        defaultEstimateMin: 60,
        rule: { kind: 'daily' },
        anchorDate: '2026-08-01',
      });
      at('2026-08-04');
      await api.getDay('2026-08-04');
      await api.deleteSeries(s.id);
      await api.deleteSeries(s.id);
      await api.deleteSeries('nope');
      expect(await api.listSeries()).toHaveLength(0);
      await expect(api.deactivateSeries(s.id)).rejects.toThrow(/Not found/);
      at('2026-08-05');
      await api.getDay('2026-08-05');
      const occurrences = (await api.listTasks()).filter((t) => t.seriesId === s.id);
      expect(occurrences).toHaveLength(1);
      expect(await api.listPlansForDay('2026-08-05')).toHaveLength(0);
    });

    it('day: a missed occurrence the series does not replace today goes to backlog', async () => {
      at('2026-08-05');
      await api.upsertSeries({
        title: 'Laundry',
        categoryId: null,
        defaultEstimateMin: 45,
        rule: { kind: 'weekly', daysOfWeek: [2] }, // Tuesdays; 2026-08-04 is a Tuesday
        anchorDate: '2026-08-01',
      });
      await api.getDay('2026-08-04');
      const [plan] = await api.listPlansForDay('2026-08-04');
      await api.getDay('2026-08-05'); // Wednesday: not due, nothing supersedes it
      expect((await api.getTask(plan!.taskId))?.status).toBe('backlog');
      expect(await api.listPlansForDay('2026-08-05')).toHaveLength(0);
    });

    it('day: getDay sweeps stale planned tasks to backlog and leaves the rest', async () => {
      at('2026-08-04');
      const plan = async (
        title: string,
        days: string[],
        status: 'planned' | 'in_progress' = 'planned',
      ) => {
        const t = await api.createTask({ title });
        const rows = [];
        for (const day of days)
          rows.push(await api.upsertPlan({ taskId: t.id, day, plannedMinutes: 30, order: 1 }));
        await api.transitionTask(t.id, 'planned');
        if (status === 'in_progress') await api.transitionTask(t.id, 'in_progress');
        return { id: t.id, rows };
      };
      const a = await plan('yesterday only', ['2026-08-03']);
      const b = await plan('yesterday and later', ['2026-08-03', '2026-08-05']);
      const c = await plan('today', ['2026-08-04']);
      const g = await plan('tomorrow only', ['2026-08-05']);
      const d = await plan('started yesterday', ['2026-08-03'], 'in_progress');
      const e = await plan('unplanned row', ['2026-08-04']);
      await api.removePlan(e.rows[0]!.id); // tombstoned rows don't count
      const f = await plan('no rows', []);
      const status = async (id: string) => (await api.getTask(id))?.status;

      await api.getDay('2026-08-03'); // a past day moves nothing today's sweep wouldn't
      expect(await status(a.id)).toBe('planned');
      expect(await status(b.id)).toBe('planned');
      expect(await status(c.id)).toBe('planned');

      await api.getDay('2026-08-04');
      expect(await status(a.id)).toBe('backlog');
      expect(await status(e.id)).toBe('backlog');
      expect(await status(f.id)).toBe('backlog');
      expect(await status(b.id)).toBe('planned');
      expect(await status(c.id)).toBe('planned');
      expect(await status(g.id)).toBe('planned');
      expect(await status(d.id)).toBe('in_progress');
      expect((await api.listPlansForDay('2026-08-03')).map((p) => p.taskId)).toContain(a.id); // history kept
      expect((await api.listBacklog()).map((t) => t.id)).toEqual(
        expect.arrayContaining([a.id, e.id, f.id]),
      );

      await api.getDay('2026-08-04'); // idempotent
      expect(await status(c.id)).toBe('planned');
    });

    it('option 3: a timed task is never planned; the same task untimed is', async () => {
      const t = await api.createTask({ title: 'OA', dueDay: '2026-08-06', dueTime: '23:59' });
      await expect(
        api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 30, order: 0 }),
      ).rejects.toThrow(/falls on/);
      expect(await api.listPlansForDay('2026-08-04')).toEqual([]);
      await api.setTaskDue(t.id, { dueDay: '2026-08-06', dueTime: null });
      await api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 30, order: 0 });
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.taskId)).toEqual([t.id]);
    });

    it('option 3: picking a roll whose open rep is timed is refused — no second rep, no row', async () => {
      const roll = await api.upsertRoll({ name: 'Mock OA', categoryId: null, estimateMin: 30 });
      const { task: rep } = await api.pickRollToday(roll.id, '2026-08-04');
      await api.setTaskDue(rep.id, { dueDay: '2026-08-05', dueTime: '17:00' });
      const before = (await api.listTasks()).length;
      await expect(api.pickRollToday(roll.id, '2026-08-05')).rejects.toThrow(/falls on/);
      expect(await api.listTasks()).toHaveLength(before);
      expect(await api.listPlansForDay('2026-08-05')).toEqual([]);
      await api.setTaskDue(rep.id, { dueDay: '2026-08-05', dueTime: null });
      expect((await api.pickRollToday(roll.id, '2026-08-05')).task.id).toBe(rep.id);
    });

    it('option 3: a planned task that gains a time goes back to backlog on the next getDay; its row stays as history', async () => {
      at('2026-08-04');
      const t = await api.createTask({ title: 'pset' });
      await api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 30, order: 0 });
      await api.transitionTask(t.id, 'planned');
      await api.setTaskDue(t.id, { dueDay: '2026-08-05', dueTime: '17:00' });
      await api.getDay('2026-08-04');
      expect((await api.getTask(t.id))?.status).toBe('backlog');
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.taskId)).toEqual([t.id]);
    });

    it('option 3: a timed first part doesn’t take its planned parent’s spot', async () => {
      const p = await api.createTask({ title: 'P2', estimateMin: 60 });
      await api.upsertPlan({ taskId: p.id, day: '2026-08-04', plannedMinutes: 60, order: 0 });
      await api.transitionTask(p.id, 'planned');
      const [timed] = await api.createTasks([
        { title: 'read', parentId: p.id, dueDay: '2026-08-05', dueTime: '10:00' },
      ]);
      expect((await api.getTask(timed!.id))?.status).toBe('backlog');
      expect((await api.listPlansForDay('2026-08-04')).map((r) => r.taskId)).not.toContain(
        timed!.id,
      );
    });

    it('option 3: splitting a timed task plans no follow-up — it’s in the backlog', async () => {
      const t = await api.createTask({ title: 'Essay', estimateMin: 90 });
      await api.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 90, order: 0 });
      await api.transitionTask(t.id, 'planned');
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskDue(t.id, { dueDay: '2026-08-04', dueTime: '17:00' });
      const { followUp } = await api.splitTask(t.id, {
        finish: 'keep',
        followUp: { title: 'Essay: edit', estimateMin: 30 },
      });
      expect(followUp.status).toBe('backlog');
      expect((await api.listPlansForDay('2026-08-04')).map((r) => r.taskId)).not.toContain(
        followUp.id,
      );
    });

    it('day: getDay refuses a future day and changes nothing', async () => {
      at('2026-08-04');
      const t = await api.createTask({ title: 'pset' });
      const row = await api.upsertPlan({
        taskId: t.id,
        day: '2026-08-04',
        plannedMinutes: 30,
        order: 0,
      });
      await api.transitionTask(t.id, 'planned');
      await expect(api.getDay('2026-08-05')).rejects.toThrow(FUTURE_DAY_ERROR);
      await expect(api.getDay('2026-13-01')).rejects.toThrow('Invalid day');
      expect((await api.getTask(t.id))?.status).toBe('planned');
      expect((await api.listPlansForDay('2026-08-04')).map((p) => p.id)).toEqual([row.id]);
      expect((await api.getDay('2026-08-03')).date).toBe('2026-08-03'); // past days are allowed
    });

    it('day: intent persists on the singleton', async () => {
      at('2026-08-04');
      const d = await api.setDayIntent('2026-08-04', 'Protect the morning');
      expect(d.intent).toBe('Protect the morning');
      expect((await api.getDay('2026-08-04')).intent).toBe('Protect the morning');
    });

    it('categories: work-flip backfills past sessions only when asked; delete reassigns referrers', async () => {
      const cat = await api.upsertCategory({ label: 'Side', isWork: true });
      const s = await api.startSession({
        taskId: null,
        categoryId: cat.id,
        kind: 'work',
        label: 'x',
        day: '2026-08-04',
      });
      expect(s.wasWork).toBe(true); // snapshot at write

      const noBackfill = await api.setCategoryWork(cat.id, false, false);
      expect(noBackfill.category.isWork).toBe(false);
      expect(noBackfill.backfilled).toBe(0);

      const withBackfill = await api.setCategoryWork(cat.id, false, true);
      expect(withBackfill.backfilled).toBe(1);
      expect((await api.listRunningSessions()).find((x) => x.id === s.id)?.wasWork).toBe(false);

      const target = await api.upsertCategory({ label: 'Other', isWork: true });
      const task = await api.createTask({ title: 't', categoryId: cat.id });
      await expect(api.deleteCategory(cat.id, null)).rejects.toThrow(); // referenced → needs a target
      await api.deleteCategory(cat.id, target.id);
      expect((await api.getTask(task.id))?.categoryId).toBe(target.id);
    });

    it('categories: area round-trips, defaults to null, is kept by a rename and a retire, and refuses a bad value', async () => {
      const cat = await api.upsertCategory({ label: 'CS 101', isWork: true });
      expect(cat.area).toBeNull(); // no area yet — reads as Personal (areaOf)
      const set = await api.setCategoryArea(cat.id, 'school');
      expect(set.area).toBe('school');
      expect((await api.listCategories()).find((c) => c.id === cat.id)?.area).toBe('school');

      // Patch-style on update: omitted keeps it; a rename and a retire never clear it.
      const renamed = await api.upsertCategory({ id: cat.id, label: 'CS 101L', isWork: true });
      expect(renamed.area).toBe('school');
      const retired = await api.upsertCategory({
        id: cat.id,
        label: 'CS 101L',
        isWork: true,
        active: false,
      });
      expect(retired.area).toBe('school');
      expect(retired.active).toBe(false);

      // A value off the set is refused with nothing written, by both write paths.
      await expect(api.setCategoryArea(cat.id, 'other' as unknown as Area)).rejects.toThrow(
        /area must be one of/,
      );
      await expect(
        api.upsertCategory({
          id: cat.id,
          label: 'x',
          isWork: false,
          area: 'Other' as unknown as Area,
        }),
      ).rejects.toThrow(/area must be one of/);
      const unchanged = (await api.listCategories()).find((c) => c.id === cat.id);
      expect(unchanged).toMatchObject({ label: 'CS 101L', isWork: true, area: 'school' });

      // Create with one; clear it back to null.
      const made = await api.upsertCategory({ label: 'LC', isWork: true, area: 'recruiting' });
      expect(made.area).toBe('recruiting');
      expect((await api.setCategoryArea(made.id, null)).area).toBeNull();
      // The same code path a foreign user's id takes (the repo is partitioned by user): not found.
      await expect(api.setCategoryArea('nope', 'school')).rejects.toThrow(/Not found/);
    });

    it('categories: an update is patch-style for label and isWork too — a label-only write keeps a flip', async () => {
      const cat = await api.upsertCategory({ label: 'A', isWork: false });
      await api.setCategoryWork(cat.id, true, false);
      // Sequential: the semantics. Two writes racing on two instances: backend.test.ts (casUpdate).
      expect(await api.upsertCategory({ id: cat.id, label: 'B' })).toMatchObject({
        label: 'B',
        isWork: true,
      });
      expect(await api.upsertCategory({ id: cat.id, order: 7 })).toMatchObject({
        label: 'B',
        isWork: true,
        order: 7,
      });
      expect(await api.upsertCategory({ id: cat.id, active: false })).toMatchObject({
        label: 'B',
        isWork: true,
        active: false,
      });
      expect(await api.upsertCategory({ id: cat.id, isWork: false })).toMatchObject({
        label: 'B',
        isWork: false,
      });
      const listed = (await api.listCategories()).find((c) => c.id === cat.id);
      expect(listed).toMatchObject({ label: 'B', isWork: false, order: 7, active: false });
    });

    it('categories: a create without label and isWork is refused', async () => {
      const before = (await api.listCategories()).length;
      await expect(
        api.upsertCategory({ label: 'x' } as unknown as Parameters<ApiClient['upsertCategory']>[0]),
      ).rejects.toThrow(/needs label and isWork/);
      expect(await api.listCategories()).toHaveLength(before);
    });

    it('categories: update keeps order/active when omitted; retire and restore round-trip', async () => {
      const cat = await api.upsertCategory({ label: 'Homework', isWork: true, order: 3 });
      const renamed = await api.upsertCategory({ id: cat.id, label: 'HW', isWork: true });
      expect(renamed.order).toBe(3);
      expect(renamed.active).toBe(true);

      const retired = await api.upsertCategory({
        id: cat.id,
        label: 'HW',
        isWork: true,
        active: false,
      });
      expect(retired.active).toBe(false);
      const renamedAgain = await api.upsertCategory({
        id: cat.id,
        label: 'Homework',
        isWork: false,
      });
      expect(renamedAgain.active).toBe(false); // a rename never un-retires
      expect(renamedAgain.order).toBe(3);
      expect((await api.listCategories()).find((c) => c.id === cat.id)?.active).toBe(false); // still listed

      const restored = await api.upsertCategory({
        id: cat.id,
        label: 'Homework',
        isWork: false,
        active: true,
      });
      expect(restored.active).toBe(true);
    });

    it('settings: sensible defaults, and patches persist', async () => {
      const s = await api.getSettings();
      expect(s.dayStartHour).toBe(4);
      expect(s.pomodoroWorkMin).toBe(25);
      const updated = await api.updateSettings({ dayStartHour: 5, pomodoroWorkMin: 50 });
      expect(updated.dayStartHour).toBe(5);
      expect(updated.pomodoroWorkMin).toBe(50);
      expect(s.financeBudgetCents).toBe(50000);
      expect(s.financePaymentDay).toBe(1);
      const fin = await api.updateSettings({ financeBudgetCents: 45000 });
      expect(fin.financeBudgetCents).toBe(45000);
      expect(s.autoCalendar).toBe(true);
      expect((await api.updateSettings({ autoCalendar: false })).autoCalendar).toBe(false);
      expect((await api.getSettings()).autoCalendar).toBe(false);
      expect(s.fluxRollId).toBeNull();
      expect(s.fluxDisclaimerAckAt).toBeNull();
      const flux = await api.updateSettings({
        fluxRollId: 'roll-1',
        fluxDisclaimerAckAt: 1_700_000_000_000,
      });
      expect(flux.fluxRollId).toBe('roll-1');
      expect(flux.fluxDisclaimerAckAt).toBe(1_700_000_000_000);
      const reset = await api.updateSettings({ fluxRollId: null, fluxDisclaimerAckAt: null });
      expect(reset.fluxRollId).toBeNull();
      expect((await api.getSettings()).fluxDisclaimerAckAt).toBeNull();
      expect(s).toMatchObject({ remindTimed: true, remindDueDay: true, remindPlanned: true });
      const quiet = await api.updateSettings({ remindTimed: false, remindPlanned: false });
      expect(quiet).toMatchObject({ remindTimed: false, remindDueDay: true, remindPlanned: false });
      expect(await api.getSettings()).toMatchObject({ remindTimed: false, remindPlanned: false });
      // A toggle off the wire must be a real boolean: a string "false" would read as on.
      for (const bad of ['false', 0, null])
        await expect(
          api.updateSettings({ remindDueDay: bad } as unknown as SettingsPatch),
        ).rejects.toThrow('remindDueDay must be true or false');
      expect((await api.getSettings()).remindDueDay).toBe(true);
    });

    it('updateStory and updateSettings refuse a key outside their patch type, writing nothing', async () => {
      const story = await api.createStory({ title: 'mine' });
      const before = await api.listStories();
      await expect(api.updateStory(story.id, { userId: 'mallory' } as never)).rejects.toThrow(
        'Unknown story field: userId',
      );
      await expect(
        api.updateStory(story.id, { title: 'ok', id: 'other', deletedAt: 1 } as never),
      ).rejects.toThrow('Unknown story field: id, deletedAt');
      // Checked before any lookup: a missing story gets the same refusal, not a Not found.
      await expect(api.updateStory('no-such-story', { userId: 'x' } as never)).rejects.toThrow(
        'Unknown story field: userId',
      );
      for (const bad of [null, [], 'title'])
        await expect(api.updateStory(story.id, bad as never)).rejects.toThrow(
          'story patch must be an object',
        );
      expect(await api.listStories()).toEqual(before);

      const settings = await api.getSettings();
      const account = { sub: 'g-other', email: 'x@example.com' };
      await expect(api.updateSettings({ googleAccounts: [account] } as never)).rejects.toThrow(
        'Unknown settings field: googleAccounts',
      );
      await expect(api.updateSettings({ deletedAt: 1 } as never)).rejects.toThrow(
        'Unknown settings field: deletedAt',
      );
      await expect(api.updateSettings(null as never)).rejects.toThrow(
        'settings patch must be an object',
      );
      expect(await api.getSettings()).toEqual(settings);
      // A legal patch still lands.
      expect((await api.updateStory(story.id, { title: 'renamed' })).title).toBe('renamed');
      expect((await api.updateSettings({ pomodoroBreakMin: 7 })).pomodoroBreakMin).toBe(7);
    });

    it('flux sets (D61): default {}, round-trips, refuses a bad count or an unknown exercise', async () => {
      expect((await api.getSettings()).fluxSets).toEqual({});
      const one = await api.updateSettings({ fluxSets: { 'chin-tuck': 3 } });
      expect(one.fluxSets).toEqual({ 'chin-tuck': 3 });
      expect((await api.getSettings()).fluxSets['chin-tuck']).toBe(3);
      await expect(api.updateSettings({ fluxSets: { 'chin-tuck': 9 } })).rejects.toThrow(/1 to 5/);
      await expect(api.updateSettings({ fluxSets: { 'chin-tuck': 1.5 } })).rejects.toThrow(/whole/);
      await expect(api.updateSettings({ fluxSets: { nope: 2 } as never })).rejects.toThrow(
        /Unknown Flux exercise/,
      );
      expect((await api.getSettings()).fluxSets).toEqual({ 'chin-tuck': 3 }); // the refusals wrote nothing
    });

    // --- Flux sets (D47) -----------------------------------------------------
    it('flux: records a set and lists it by range and exercise, newest first', async () => {
      const a = await api.recordFluxSet(fluxSet({ day: '2026-10-19', completedAt: 1_000 }));
      const b = await api.recordFluxSet(
        fluxSet({
          day: '2026-10-20',
          completedAt: 2_000,
          exerciseId: 'chin-tuck',
          kind: 'holdAtTarget',
          count: 10,
          avgPeakDeg: null,
        }),
      );
      expect(a).toMatchObject({
        day: '2026-10-19',
        exerciseId: 'cervical-rotation',
        avgPeakDeg: 52.5,
        deletedAt: null,
      });
      expect((await api.listFluxSets()).map((s) => s.id)).toEqual([b.id, a.id]);
      expect(
        (await api.listFluxSets({ from: '2026-10-19', to: '2026-10-19' })).map((s) => s.id),
      ).toEqual([a.id]);
      expect((await api.listFluxSets({ exerciseId: 'chin-tuck' })).map((s) => s.id)).toEqual([
        b.id,
      ]);
      await expect(api.listFluxSets({ from: '2026-10-19' })).rejects.toThrow('both from and to');
    });

    it('flux: is idempotent on the client id — a retry keeps the first row', async () => {
      const input = fluxSet();
      const first = await api.recordFluxSet(input);
      advance(60_000);
      const again = await api.recordFluxSet({ ...input, count: 99 });
      expect(again).toEqual(first);
      expect(await api.listFluxSets()).toHaveLength(1);
    });

    it('flux: refuses an unknown exercise, a wrong kind, and a side the exercise lacks or needs', async () => {
      await expect(api.recordFluxSet(fluxSet({ exerciseId: 'nope' }))).rejects.toThrow(
        'Unknown Flux exercise',
      );
      await expect(api.recordFluxSet(fluxSet({ kind: 'guidedHold' }))).rejects.toThrow('romReps');
      await expect(api.recordFluxSet(fluxSet({ side: 'a' }))).rejects.toThrow('has no side');
      await expect(
        api.recordFluxSet(
          fluxSet({ exerciseId: 'upper-trap-stretch', kind: 'holdAtTarget', side: null }),
        ),
      ).rejects.toThrow('needs a side');
      expect(await api.listFluxSets()).toEqual([]);
    });

    it('flux: a stopped-early set round-trips its flag and planned count; an empty one is refused', async () => {
      const stopped = await api.recordFluxSet(
        fluxSet({ count: 2, stoppedEarly: true, planned: 10 }),
      );
      expect(stopped).toMatchObject({ count: 2, stoppedEarly: true, planned: 10 });
      expect((await api.listFluxSets()).find((s) => s.id === stopped.id)).toMatchObject({
        stoppedEarly: true,
        planned: 10,
      });
      await expect(
        api.recordFluxSet(fluxSet({ count: 0, stoppedEarly: true, planned: 10 })),
      ).rejects.toThrow('first rep');
    });

    it('flux: delete is a soft-delete — gone from list and export, and a retry of it stays gone', async () => {
      const input = fluxSet();
      const kept = await api.recordFluxSet(fluxSet());
      const gone = await api.recordFluxSet(input);
      await api.deleteFluxSet(gone.id);
      await api.deleteFluxSet('01HZZZZZZZZZZZZZZZZZZZZZZZ'); // absent: a no-op
      expect((await api.listFluxSets()).map((s) => s.id)).toEqual([kept.id]);
      expect((await api.exportData()).fluxSets.map((s) => s.id)).toEqual([kept.id]);
      // An outbox retry of the deleted set doesn't bring it back — and a second delete changes nothing.
      const first = (await api.recordFluxSet(input)).deletedAt;
      expect(first).not.toBeNull();
      advance(1000);
      await api.deleteFluxSet(gone.id);
      expect((await api.recordFluxSet(input)).deletedAt).toBe(first);
      expect((await api.listFluxSets()).map((s) => s.id)).toEqual([kept.id]);
    });

    // ExportBundle now catches a missing OR stray key at compile time (both impls return a checked
    // object literal), so this assertion is a runtime backstop rather than the primary guard. It still
    // earns its place: excess-property checking evaporates the moment an impl returns a variable, a
    // spread, or an `as` cast, and it can't see a declared-but-actually-undefined value or a key the
    // HTTP layer's JSON round-trip drops. Listing the collections here is deliberate double-entry —
    // don't replace it with a constant the implementations also import.
    it('calibration integrity: done without an estimate or with actual 0 is refused', async () => {
      const bare = await api.createTask({ title: 'bare' });
      await api.transitionTask(bare.id, 'in_progress');
      await api.setTaskActual(bare.id, 10);
      await expect(api.transitionTask(bare.id, 'done')).rejects.toThrow(/estimate and an actual/);
      const idle = await api.createTask({ title: 'idle', estimateMin: 30 });
      await api.transitionTask(idle.id, 'in_progress');
      await expect(api.transitionTask(idle.id, 'done')).rejects.toThrow(/estimate and an actual/);
      await api.setTaskActual(idle.id, 0); // still fine while open
      await expect(api.transitionTask(idle.id, 'done')).rejects.toThrow(/estimate and an actual/);
      expect((await api.getTask(idle.id))?.status).toBe('in_progress');
    });

    it('calibration integrity: a retro estimate locks at done, and the source says how', async () => {
      const finish = async (id: string, actual: number) => {
        await api.setTaskActual(id, actual);
        return api.transitionTask(id, 'done');
      };
      const late = await api.createTask({ title: 'late' });
      await api.transitionTask(late.id, 'in_progress');
      await api.setTaskEstimate(late.id, 25, null);
      expect(await finish(late.id, 40)).toMatchObject({
        estimateLockedMin: 25,
        estimateSource: 'retro',
      });
      const planned = await api.createTask({ title: 'planned', estimateMin: 30 });
      await api.transitionTask(planned.id, 'in_progress');
      expect((await finish(planned.id, 40)).estimateSource).toBe('planned');
      const revised = await api.createTask({ title: 'revised', estimateMin: 30 });
      await api.transitionTask(revised.id, 'in_progress');
      await api.setTaskEstimate(revised.id, 60, null);
      expect(await finish(revised.id, 75)).toMatchObject({
        estimateLockedMin: 30,
        estimateSource: 'revised',
      });
      const points = await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
      expect(points.find((p) => p.taskId === revised.id)).toMatchObject({
        estimateLockedMin: 30,
        estimateMin: 60,
        estimateSource: 'revised',
      });
      expect(points.find((p) => p.taskId === late.id)?.estimateSource).toBe('retro');
    });

    it('calibration integrity: rollover keeps the lock through a rescope', async () => {
      const t = await api.createTask({ title: 'rolled', estimateMin: 30 });
      await api.transitionTask(t.id, 'in_progress');
      await api.transitionTask(t.id, 'backlog');
      await api.setTaskEstimate(t.id, 45, null);
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskActual(t.id, 50);
      expect(await api.transitionTask(t.id, 'done')).toMatchObject({
        estimateLockedMin: 30,
        estimateSource: 'revised',
      });
    });

    it('calibration integrity: a done task takes no actual of 0, a cancelled estimate stays read-only', async () => {
      const t = await api.createTask({ title: 'measured', estimateMin: 30 });
      await api.transitionTask(t.id, 'in_progress');
      await api.setTaskActual(t.id, 20);
      await api.transitionTask(t.id, 'done');
      await expect(api.setTaskActual(t.id, 0)).rejects.toThrow(/estimate and an actual/);
      expect((await api.getTask(t.id))?.actualAccruedMin).toBe(20);
      await expect(api.setTaskEstimate(t.id, 90, null)).rejects.toThrow(/history/); // it has a lock
      const gone = await api.createTask({ title: 'gone' });
      await api.transitionTask(gone.id, 'cancelled');
      await expect(api.setTaskEstimate(gone.id, 90, null)).rejects.toThrow(/history/);
    });

    it('calibration integrity: a parent whose parts went takes one backfill, as a legacy row does', async () => {
      const p = await api.createTask({ title: 'was a parent' });
      const part = await api.createTask({ title: 'its part', parentId: p.id });
      await api.transitionTask(part.id, 'in_progress');
      await api.setTaskEstimate(part.id, 5, null);
      await api.setTaskActual(part.id, 7);
      await api.transitionTask(part.id, 'done');
      const done = await api.transitionTask(p.id, 'done');
      expect(done).toMatchObject({ estimateLockedMin: null, actualAccruedMin: 7 });
      await expect(api.setTaskEstimate(p.id, 30, null)).rejects.toThrow(); // still a parent
      await api.deleteTask(part.id);
      expect(await api.setTaskEstimate(p.id, 30, null)).toMatchObject({
        estimateLockedMin: 30,
        estimateSource: 'retro',
      });
      await expect(api.setTaskEstimate(p.id, 40, null)).rejects.toThrow(/history/);
    });

    it('calibration integrity: a done split of an unscoped task needs its estimate; the follow-up is unaffected', async () => {
      const t = await api.createTask({ title: 'unscoped split' });
      await api.transitionTask(t.id, 'in_progress');
      const followUp = { title: 'rest', estimateMin: null };
      await expect(
        api.splitTask(t.id, { finish: 'done', actualMin: 20, followUp }),
      ).rejects.toThrow(/estimate and an actual/);
      expect((await api.listTasks()).filter((x) => x.title === 'rest')).toEqual([]); // nothing written
      const split = await api.splitTask(t.id, {
        finish: 'done',
        actualMin: 20,
        estimateMin: 15,
        followUp,
      });
      expect(split.original).toMatchObject({
        status: 'done',
        estimateLockedMin: 15,
        estimateSource: 'retro',
      });
      expect(split.followUp).toMatchObject({ estimateMin: null, estimateLockedMin: null });
      expect(split.followUp.estimateSource ?? null).toBeNull();
    });

    it('export: exposes exactly the known collections, with created entities in them', async () => {
      const t = await api.createTask({ title: 'exportable' });
      const { sitting } = await startSitting(api, { problem: { titleSlug: 'two-sum' } });
      await api.lcSittingEvents({
        sittingId: sitting.id,
        events: [lcSnap('a', LC_T0 + 1), lcJudged('submit', 10, 'Accepted', LC_T0 + 2, 1, 1)],
      });
      const story = await api.createStory({ title: 'exportable story' });
      const flux = await api.recordFluxSet(fluxSet());
      const { attachment } = await api.createAttachmentUploadUrl({
        taskId: t.id,
        filename: 'e.png',
        contentType: 'image/png',
        size: 10,
      });
      await api.confirmAttachment(attachment.id);
      const data = await api.exportData();
      expect(Object.keys(data).sort()).toEqual(
        [
          'attachments',
          'categories',
          'days',
          'exportedAt',
          'financeAccounts',
          'financeItems',
          'financeRules',
          'financeSyncStates',
          'financeTransactions',
          'fluxSets',
          'gcalSyncStates',
          'habitChecks',
          'habits',
          'ideas',
          'leetcodeProblems',
          'logEntries',
          'places',
          'plans',
          'rolls',
          'series',
          'sessions',
          'settings',
          'sittingHeadRows',
          'sittingLive',
          'sittings',
          'stories',
          'tasks',
          'userId',
        ].sort(),
      );
      expect(data.tasks.map((x) => x.id)).toContain(t.id);
      expect(data.sittings.map((x) => x.id)).toContain(sitting.id);
      expect(data.leetcodeProblems.map((x) => x.slug)).toContain('two-sum');
      // Runs and submits are kept; the raw bulk (snapshots) and the replay stay out.
      expect(data.sittingHeadRows.map((e) => [e.type, e.verdict?.verdict])).toEqual([
        ['submit', 'accepted'],
      ]);
      expect(data.sittingLive.map((l) => l.sittingId)).toEqual([sitting.id]);
      expect(data.stories.map((x) => x.id)).toContain(story.id);
      expect(data.fluxSets.map((x) => x.id)).toContain(flux.id);
      expect(data.attachments.map((x) => x.id)).toContain(attachment.id); // ready rows only
      // Materialised, never the stub's nullable storage state — nothing in this test triggers
      // ensureSettings() beforehand, so a stub that exported store.settings raw would fail here.
      expect(data.settings).toBeTruthy();
    });

    // Soft-deleted rows stay out of the export. The two impls used to disagree — the stub spread its
    // raw store (tombstones included), the backend's repo reads are alive()-filtered (excluded) — and
    // no type can catch that, since both are well-typed arrays of the same element. Two probes because
    // they take different paths: deleteCategory writes deletedAt (the backend via updateCategory's casUpdate), removePlan goes
    // through the stub's softDelete. (Not uncheckHabit — the stub soft-deletes it but the backend
    // hard-deletes, so it can't distinguish filtering from absence.)
    it('export: excludes soft-deleted rows', async () => {
      const gone = await api.upsertCategory({ label: 'Gone', isWork: false });
      const kept = await api.upsertCategory({ label: 'Kept', isWork: true });
      await api.deleteCategory(gone.id, null); // unreferenced → a null target is allowed

      const task = await api.createTask({ title: 'planned then unplanned' });
      const plan = await api.upsertPlan({
        taskId: task.id,
        day: '2026-01-05',
        plannedMinutes: 30,
        order: 1,
      });
      await api.removePlan(plan.id);

      // A confirmed-then-deleted attachment is a tombstone; a never-confirmed one is pending. Neither
      // belongs in the export (ready + alive only).
      const { attachment: goneAtt } = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'gone.png',
        contentType: 'image/png',
        size: 10,
      });
      await api.confirmAttachment(goneAtt.id);
      await api.deleteAttachment(goneAtt.id);
      const { attachment: pendingAtt } = await api.createAttachmentUploadUrl({
        taskId: task.id,
        filename: 'pending.png',
        contentType: 'image/png',
        size: 10,
      });

      const data = await api.exportData();
      expect(data.categories.map((c) => c.id)).toContain(kept.id);
      expect(data.categories.map((c) => c.id)).not.toContain(gone.id);
      expect(data.plans.map((p) => p.id)).not.toContain(plan.id);
      expect(data.tasks.map((t) => t.id)).toContain(task.id); // the task itself survives
      expect(data.attachments.map((a) => a.id)).not.toContain(goneAtt.id); // tombstoned
      expect(data.attachments.map((a) => a.id)).not.toContain(pendingAtt.id); // never confirmed
    });

    // --- Finances ------------------------------------------------------------
    // Both impls replay the shared Sandbox-shaped fixtures (financeFixtures.ts) anchored to the same
    // day, the user's (the stub's local day, under the app's pinned zone), and both run the sync inline
    // here (stub: in-process; lambda: InlineInvoker + InMemoryPlaid), so the whole connect → sync →
    // sort loop is compared end to end.
    const finToday = () => dayKeyInZone(clock, USER_TIME_ZONE, 4); // the user's day, as the Lambda reads it
    const connectBare = () =>
      api.exchangePlaidPublicToken({
        publicToken: 'public-fixture',
        institution: FIXTURE_INSTITUTION,
        accounts: FIXTURE_LINK_ACCOUNTS,
      });
    // Connect, then mark both fixture card payments — the period starts today−8, previous today−38.
    const connect = async () => {
      const item = await connectBare();
      for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
        await api.setFinancePeriodStart(id, true);
      return item;
    };
    const finRange = async () => {
      const o = await api.getFinanceOverview({ today: finToday() });
      return { from: o.period.previous.start, to: o.period.end };
    };

    it('finance: an empty overview falls back to the payment day and the default budget', async () => {
      const o = await api.getFinanceOverview({ today: finToday() });
      expect(o.items).toEqual([]);
      expect(o.accounts).toEqual([]);
      expect(o.period.source).toBe('payment_day');
      expect(o.period.lastPaymentDate).toBeNull();
      expect(o.budgetCents).toBe(50000);
      expect(o.leftCents).toBe(50000);
      expect(o.unsortedCount).toBe(0);
      expect(o.sync.lastSyncedAt).toBeNull();
      expect([o.sync.lastError, o.sync.lastErrorAt]).toEqual([null, null]);
    });

    it('finance: connect → sync → list → bucket → overview', async () => {
      const link = await api.createPlaidLinkToken({ mode: 'connect' });
      expect(link.linkToken).toBeTruthy();
      const item = await connect();
      expect(item.institutionName).toBe('First Platypus Bank');
      expect(item.status).toBe('ok');

      const o = await api.getFinanceOverview({ today: finToday() });
      expect(o.accounts).toHaveLength(3);
      expect(o.period.source).toBe('marked');
      expect(o.unsortedCount).toBeGreaterThan(0);
      expect(o.sync.lastSyncedAt).not.toBeNull();
      expect(o.sync.syncing).toBe(false);

      const txns = await api.listFinanceTransactions(await finRange());
      const chipotle = txns.filter(
        (t) => t.merchantName === 'Chipotle' && t.date >= o.period.start,
      );
      expect(chipotle.length).toBeGreaterThan(0);
      expect(txns.map((t) => t.date)).toEqual([...txns.map((t) => t.date)].sort().reverse()); // date desc

      const set = await api.setFinanceBucket({ ids: chipotle.map((t) => t.id), bucket: 'budget' });
      expect(set.every((t) => t.bucket === 'budget' && t.bucketSetBy === 'user')).toBe(true);
      const total = chipotle.reduce((n, t) => n + t.rawAmountCents, 0);
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.spentCents).toBe(total);
      expect(after.leftCents).toBe(50000 - total);
      expect(after.unsortedCount).toBe(o.unsortedCount - chipotle.length);

      // Push one charge into the previous period → it leaves the current total.
      await api.setFinancePeriodOverride(chipotle[0]!.id, 'previous');
      const moved = await api.getFinanceOverview({ today: finToday() });
      expect(moved.spentCents).toBe(total - chipotle[0]!.rawAmountCents);

      const noted = await api.setFinanceNote(chipotle[0]!.id, 'split with sam');
      expect(noted.note).toBe('split with sam');
      const unsorted = await api.setFinanceBucket({ ids: [chipotle[0]!.id], bucket: null });
      expect(unsorted[0]!.bucketSetBy).toBeNull();
    });

    it('finance: "Always" saves a rule and applies it to every unsorted match', async () => {
      await connect();
      const txns = await api.listFinanceTransactions({
        from: addDays(finToday(), -400),
        to: finToday(),
      });
      const uber = txns.filter((t) => t.merchantName === 'Uber');
      expect(uber.length).toBeGreaterThan(1);
      const changed = await api.setFinanceBucket({
        ids: [uber[0]!.id],
        bucket: 'i_pay',
        rule: { pattern: '  Uber ' },
      });
      expect(changed.map((t) => t.id).sort()).toEqual(uber.map((t) => t.id).sort());
      expect(changed.find((t) => t.id === uber[0]!.id)!.bucketSetBy).toBe('user');
      expect(
        changed.filter((t) => t.id !== uber[0]!.id).every((t) => t.bucketSetBy === 'rule'),
      ).toBe(true);
      const rules = await api.listFinanceRules();
      expect(rules.map((r) => [r.pattern, r.bucket])).toEqual([['uber', 'i_pay']]);

      // Saving the same pattern again updates the rule instead of duplicating it.
      await api.upsertFinanceRule({ pattern: 'UBER', bucket: 'budget' });
      expect((await api.listFinanceRules()).map((r) => [r.pattern, r.bucket])).toEqual([
        ['uber', 'budget'],
      ]);
      const extra = await api.upsertFinanceRule({ pattern: 'amazon', bucket: 'parents_pay' });
      await api.deleteFinanceRule(extra.id);
      expect((await api.listFinanceRules()).map((r) => r.pattern)).toEqual(['uber']);
      await expect(api.upsertFinanceRule({ pattern: '   ', bucket: 'budget' })).rejects.toThrow();
      await expect(
        api.setFinanceBucket({ ids: [uber[0]!.id], bucket: null, rule: { pattern: 'uber' } }),
      ).rejects.toThrow();
    });

    it('finance: "Not spending" leaves every total and the queue; Always makes it stick', async () => {
      await connect();
      const o = await api.getFinanceOverview({ today: finToday() });
      const txns = await api.listFinanceTransactions(await finRange());
      const uber = txns.filter((t) => t.merchantName === 'Uber' && t.bucket === null);
      expect(uber.length).toBeGreaterThan(0);
      const changed = await api.setFinanceBucket({
        ids: [uber[0]!.id],
        bucket: 'not_spending',
        rule: { pattern: 'uber' },
      });
      expect(changed.every((t) => t.bucket === 'not_spending')).toBe(true);
      const changedIds = changed.map((t) => t.id);
      for (const t of uber) expect(changedIds).toContain(t.id); // the sweep reached every one
      expect(changed.find((t) => t.id === uber[0]!.id)!.bucketSetBy).toBe('user');
      expect(
        changed.filter((t) => t.id !== uber[0]!.id).every((t) => t.bucketSetBy === 'rule'),
      ).toBe(true);
      expect((await api.listFinanceRules()).map((r) => [r.pattern, r.bucket])).toEqual([
        ['uber', 'not_spending'],
      ]);
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.unsortedCount).toBe(o.unsortedCount - uber.length);
      expect(after.unsortedCents).toBe(
        o.unsortedCents - uber.reduce((n, t) => n + t.rawAmountCents, 0),
      );
      expect(after.buckets).toEqual(o.buckets);
      expect(after.spentCents).toBe(o.spentCents);

      // Budget → Not spending puts spent back exactly where it was.
      const inv = txns.find((t) => t.id === 'fx-brokerage')!;
      await api.setFinanceBucket({ ids: [inv.id], bucket: 'budget' });
      const inBudget = await api.getFinanceOverview({ today: finToday() });
      expect(inBudget.spentCents).toBe(after.spentCents + inv.rawAmountCents);
      await api.setFinanceBucket({ ids: [inv.id], bucket: 'not_spending' });
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(
        after.spentCents,
      );

      await expect(
        api.setFinanceBucket({ ids: [inv.id], bucket: 'bogus' as never }),
      ).rejects.toThrow('Unknown bucket: bogus');
      await expect(
        api.upsertFinanceRule({ pattern: 'x', bucket: 'bogus' as never }),
      ).rejects.toThrow('Unknown bucket: bogus');
    });

    it('finance: refuses to link the same accounts twice', async () => {
      await connect();
      await expect(connect()).rejects.toThrow(/already/i);
      expect((await api.getFinanceOverview({ today: finToday() })).items).toHaveLength(1);
    });

    it("finance: a posted charge inherits the pending row's bucket and note", async () => {
      await connect();
      await api.setFinanceBucket({ ids: ['fx-pending-1'], bucket: 'parents_pay' });
      await api.setFinanceNote('fx-pending-1', 'dinner');
      advance(1000);
      const r = await api.requestFinanceSync({ refresh: false });
      expect(r.accepted).toBe(true);
      const txns = await api.listFinanceTransactions(await finRange());
      expect(txns.find((t) => t.id === 'fx-pending-1')).toBeUndefined();
      const posted = txns.find((t) => t.id === 'fx-posted-1')!;
      expect(posted.bucket).toBe('parents_pay');
      expect(posted.note).toBe('dinner');
      expect(posted.pending).toBe(false);
    });

    it('finance: a posted charge inherits a pending row’s Not spending', async () => {
      await connect();
      await api.setFinanceBucket({ ids: ['fx-pending-1'], bucket: 'not_spending' });
      advance(1000);
      await api.requestFinanceSync({ refresh: false });
      const txns = await api.listFinanceTransactions(await finRange());
      expect(txns.find((t) => t.id === 'fx-posted-1')!.bucket).toBe('not_spending');
    });

    it('finance: refresh has a cooldown', async () => {
      await connect();
      expect((await api.requestFinanceSync({ refresh: true })).accepted).toBe(true);
      const refused = await api.requestFinanceSync({ refresh: true });
      expect(refused.accepted).toBe(false);
      expect(refused.nextAllowedAt).toBeGreaterThan(clock);
      advance(FINANCE_REFRESH_COOLDOWN_MS);
      expect((await api.requestFinanceSync({ refresh: true })).accepted).toBe(true);
    });

    it('finance: account flip/hide persist, and removing the item drops it from the overview', async () => {
      const item = await connect();
      const o = await api.getFinanceOverview({ today: finToday() });
      const card = o.accounts.find((a) => a.type === 'credit')!;
      const flipped = await api.updateFinanceAccount(card.id, { signOverride: 'flip' });
      expect(flipped.signOverride).toBe('flip');
      const hidden = await api.updateFinanceAccount(card.id, { hidden: true });
      expect(hidden.hidden).toBe(true);
      expect(hidden.signOverride).toBe('flip');

      const updated = await api.completePlaidUpdate(item.id);
      expect(updated.id).toBe(item.id);

      await api.removePlaidItem(item.id);
      const gone = await api.getFinanceOverview({ today: finToday() });
      expect(gone.items).toEqual([]);
      expect(gone.accounts).toEqual([]);
      expect(gone.unsortedCount).toBe(0);
    });

    it('finance: hidden and flipped accounts change the totals the same way everywhere', async () => {
      await connect();
      const o = await api.getFinanceOverview({ today: finToday() });
      const card = o.accounts.find((a) => a.type === 'credit')!;
      const txns = await api.listFinanceTransactions(await finRange());
      const charge = txns.find(
        (t) => t.accountId === card.id && t.rawAmountCents > 0 && t.date >= o.period.start,
      )!;
      await api.setFinanceBucket({ ids: [charge.id], bucket: 'budget' });
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(
        charge.rawAmountCents,
      );

      // Flipped, the charge reads as a card credit (a refund) and nets negative.
      await api.updateFinanceAccount(card.id, { signOverride: 'flip' });
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(
        -charge.rawAmountCents,
      );

      await api.updateFinanceAccount(card.id, { signOverride: 'auto', hidden: true });
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(0);
    });

    it('finance: a "current" override pulls a last-period charge into this period', async () => {
      await connect();
      const o = await api.getFinanceOverview({ today: finToday() });
      const txns = await api.listFinanceTransactions(await finRange());
      const old = txns.find(
        (t) =>
          t.accountId === 'acct-fixture-card' && t.rawAmountCents > 0 && t.date < o.period.start,
      )!;
      await api.setFinanceBucket({ ids: [old.id], bucket: 'budget' });
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(0);
      await api.setFinancePeriodOverride(old.id, 'current');
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(
        old.rawAmountCents,
      );
    });

    it('finance: unknown ids — bucket sets are all-or-nothing, account patch throws, remove is a no-op', async () => {
      await connect();
      const [first] = await api.listFinanceTransactions(await finRange());
      await expect(
        api.setFinanceBucket({ ids: [first!.id, 'nope'], bucket: 'budget' }),
      ).rejects.toThrow();
      const again = await api.listFinanceTransactions(await finRange());
      expect(again.find((t) => t.id === first!.id)!.bucket).toBe(first!.bucket); // untouched
      await expect(api.updateFinanceAccount('nope', { hidden: true })).rejects.toThrow();
      await api.removePlaidItem('nope');
      expect((await api.getFinanceOverview({ today: finToday() })).items).toHaveLength(1);
    });

    it('finance: linking a refund nets it against the charge’s bucket and period', async () => {
      await connect();
      await api.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' });
      const before = await api.getFinanceOverview({ today: finToday() });
      expect(before.spentCents).toBe(3000);

      const linked = await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
      expect(linked.refundOfId).toBe('fx-card-8');
      expect(linked.bucket).toBeNull();
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.spentCents).toBe(0);
      expect(after.unsortedCount).toBe(before.unsortedCount - 1);

      await api.linkFinanceRefund('fx-refund-1', null);
      const unlinked = await api.getFinanceOverview({ today: finToday() });
      expect(unlinked.spentCents).toBe(3000);
      expect(unlinked.unsortedCount).toBe(before.unsortedCount);
    });

    it('finance: a partial refund nets partially and follows the charge into its period', async () => {
      await connect();
      await api.linkFinanceRefund('fx-refund-2', 'fx-card-14');
      await api.setFinanceBucket({ ids: ['fx-card-14'], bucket: 'budget' });
      // The charge is in the previous period — so is its refund, though it's dated this period.
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(0);
      await api.setFinancePeriodOverride('fx-card-14', 'current');
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(2500 - 1500);
    });

    it('finance: refund link validation', async () => {
      await connect();
      await expect(api.linkFinanceRefund('fx-card-8', 'fx-card-2')).rejects.toThrow(); // charge as refund
      await expect(api.linkFinanceRefund('fx-refund-1', 'fx-refund-2')).rejects.toThrow(); // onto a credit
      await expect(api.linkFinanceRefund('fx-refund-1', 'fx-refund-1')).rejects.toThrow(); // self
      // Any size: $15 onto a $5.00 charge links, and counts only $5.00 (capRefunds).
      expect((await api.linkFinanceRefund('fx-refund-2', 'fx-card-10')).refundOfId).toBe(
        'fx-card-10',
      );
      await api.linkFinanceRefund('fx-refund-2', null);
      await expect(api.linkFinanceRefund('fx-ccpay-card-10', 'fx-card-8')).rejects.toThrow(); // a payment
      await expect(api.linkFinanceRefund('nope', 'fx-card-8')).rejects.toThrow();
      await expect(api.linkFinanceRefund('fx-refund-1', 'nope')).rejects.toThrow();
      await expect(api.linkFinanceRefund('fx-refund-2', 'fx-xfer-chk')).rejects.toThrow(); // transfer out

      await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
      // "Always" for the merchant sorts the other Amazon charges but leaves the linked refund alone.
      await api.setFinanceBucket({
        ids: ['fx-card-28'],
        bucket: 'i_pay',
        rule: { pattern: 'amazon' },
      });
      const txns = await api.listFinanceTransactions({
        from: addDays(finToday(), -400),
        to: finToday(),
      });
      const refund = txns.find((t) => t.id === 'fx-refund-1')!;
      expect(refund.bucket).toBeNull();
      expect(refund.refundOfId).toBe('fx-card-8');

      // Sorting or moving a linked refund yourself unlinks it.
      const [sorted] = await api.setFinanceBucket({ ids: ['fx-refund-1'], bucket: 'budget' });
      expect([sorted!.bucket, sorted!.refundOfId]).toEqual(['budget', null]);
      await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
      const moved = await api.setFinancePeriodOverride('fx-refund-1', 'current');
      expect(moved.refundOfId).toBeNull();
    });

    it('finance: a transfer-tagged deposit links as the refund of a checking charge and nets it to $0', async () => {
      await connect();
      await api.setFinanceBucket({ ids: ['fx-rent'], bucket: 'budget' });
      const before = await api.getFinanceOverview({ today: finToday() });
      expect(before.spentCents).toBe(80000);
      // $800.50 back against $800.00: links, and counts only what was left of the charge.
      const linked = await api.linkFinanceRefund('fx-reimburse', 'fx-rent');
      expect(linked.refundOfId).toBe('fx-rent');
      const after = await api.getFinanceOverview({ today: finToday() });
      expect([after.spentCents, after.leftCents]).toEqual([0, 50000]);
      expect(after.unsortedCount).toBe(before.unsortedCount);
      const view = deriveFinanceView(
        after,
        await api.listFinanceTransactions(financeListRange(finToday(), after)),
      );
      expect(view.refunded.get('fx-rent')).toBe(80000);
      expect(view.counted.get('fx-reimburse')).toBe(80000);
      await api.linkFinanceRefund('fx-reimburse', null);
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(80000);
    });

    it('finance: an over-refund on an unsorted charge takes it out of the queue, never below $0', async () => {
      await connect();
      const before = await api.getFinanceOverview({ today: finToday() });
      await api.linkFinanceRefund('fx-reimburse', 'fx-rent');
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.unsortedCount).toBe(before.unsortedCount - 1);
      expect(after.unsortedCents).toBe(before.unsortedCents - 80000);
    });

    it('finance: two refunds where the second over-covers count only up to the charge', async () => {
      await connect();
      await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
      await api.linkFinanceRefund('fx-refund-2', 'fx-card-8');
      await api.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' });
      const o = await api.getFinanceOverview({ today: finToday() });
      expect(o.spentCents).toBe(0);
      const view = deriveFinanceView(
        o,
        await api.listFinanceTransactions(financeListRange(finToday(), o)),
      );
      expect(view.refunded.get('fx-card-8')).toBe(3000);
      expect(view.counted.get('fx-refund-2')).toBe(0); // the later refund found the charge used up
    });

    it('finance: a refund link survives its charge going pending→posted', async () => {
      await connect();
      await api.linkFinanceRefund('fx-refund-2', 'fx-pending-1');
      await api.setFinanceBucket({ ids: ['fx-pending-1'], bucket: 'parents_pay' });
      advance(1000);
      await api.requestFinanceSync({ refresh: false });
      const txns = await api.listFinanceTransactions(await finRange());
      expect(resolveRefundLinks(txns).get('fx-refund-2')?.id).toBe('fx-posted-1');
      const o = await api.getFinanceOverview({ today: finToday() });
      expect(o.buckets.parents_pay.totalCents).toBe(2600 - 1500);
      expect(
        (await api.exportData()).financeTransactions.find((t) => t.id === 'fx-refund-2')!
          .refundOfId,
      ).toBe('fx-pending-1');
    });

    it('finance: marking the card payment sets the period; unmarking falls back', async () => {
      await connectBare();
      const today = finToday();
      expect((await api.getFinanceOverview({ today })).period.source).toBe('payment_day');

      const marked = await api.setFinancePeriodStart('fx-ccpay-card-10', true);
      expect(marked.startsPeriod).toBe(true);
      const one = (await api.getFinanceOverview({ today })).period;
      expect([one.source, one.start, one.previous.end]).toEqual([
        'marked',
        addDays(today, -8),
        addDays(today, -9),
      ]);
      await api.setFinancePeriodStart('fx-ccpay-card-40', true);
      expect((await api.getFinanceOverview({ today })).period.previous.start).toBe(
        addDays(today, -38),
      );
      await api.setFinancePeriodStart('fx-ccpay-card-10', false);
      expect((await api.getFinanceOverview({ today })).period.start).toBe(addDays(today, -38));

      await expect(api.setFinancePeriodStart('fx-card-8', true)).rejects.toThrow(); // a charge
      await expect(api.setFinancePeriodStart('fx-ccpay-chk-10', true)).rejects.toThrow(); // checking
      await expect(api.setFinancePeriodStart('nope', true)).rejects.toThrow();
      const data = await api.exportData();
      expect(data.financeTransactions.find((t) => t.id === 'fx-ccpay-card-40')!.startsPeriod).toBe(
        true,
      );
    });

    it('finance: marking a linked card credit clears its bucket and link and moves the period', async () => {
      await connect();
      await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
      const marked = await api.setFinancePeriodStart('fx-refund-1', true);
      expect([marked.startsPeriod, marked.bucket, marked.refundOfId]).toEqual([true, null, null]);
      const o = await api.getFinanceOverview({ today: finToday() });
      expect(o.period.start).toBe(addDays(finToday(), -2)); // the day after the new mark
      await expect(api.linkFinanceRefund('fx-refund-1', 'fx-card-8')).rejects.toThrow();

      // Unmarking leaves it a plain, unsorted card credit — the old link isn't restored.
      const back = await api.setFinancePeriodStart('fx-refund-1', false);
      expect([back.startsPeriod, back.refundOfId]).toEqual([false, null]);
    });

    it('finance: a checking refund links to its debit charge and nets it', async () => {
      await connect();
      await api.setFinanceBucket({ ids: ['fx-safeway'], bucket: 'budget' });
      const before = await api.getFinanceOverview({ today: finToday() });
      expect(before.spentCents).toBe(5500);

      await api.linkFinanceRefund('fx-refund-3', 'fx-safeway');
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.spentCents).toBe(0);
      expect(after.unsortedCount).toBe(before.unsortedCount); // a deposit was never in the queue

      await api.linkFinanceRefund('fx-refund-3', null);
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(5500);

      await api.linkFinanceRefund('fx-refund-1', 'fx-safeway'); // a card credit → a debit charge
      await expect(api.linkFinanceRefund('fx-xfer-sav', 'fx-safeway')).rejects.toThrow(); // transfer in
      await expect(api.linkFinanceRefund('fx-refund-3', 'fx-venmo')).rejects.toThrow(); // transfer out
      await expect(api.linkFinanceRefund('fx-ccpay-card-10', 'fx-card-8')).rejects.toThrow(); // marked
    });

    it('calendar pull: with no connected account it does nothing (parity: *.calendar.test.ts)', async () => {
      expect(await api.pullCalendar()).toEqual({ pulled: false, changedTaskIds: [], accounts: [] });
      expect((await api.exportData()).gcalSyncStates).toEqual([]);
    });

    it('finance: export carries items, accounts, transactions and rules', async () => {
      await connect();
      await api.upsertFinanceRule({ pattern: 'netflix', bucket: 'i_pay' });
      const data = await api.exportData();
      expect(data.financeItems).toHaveLength(1);
      expect(data.financeAccounts).toHaveLength(3);
      expect(data.financeTransactions.length).toBeGreaterThan(10);
      expect(data.financeRules.map((r) => r.pattern)).toEqual(['netflix']);
    });

    it('places: create slugs the name, list keeps add order, and refuses a clash or a bad slug', async () => {
      const grocer = await api.upsertPlace({ name: 'Grocer' });
      expect(grocer).toMatchObject({ name: 'Grocer', slug: 'grocer', lastReadAt: null });
      advance(1); // add order is createdAt; a same-ms tie falls to the ULID, random across Lambda calls
      const thrift = await api.upsertPlace({ name: "Thrift Jo's", slug: 'jo' });
      expect((await api.listPlaces()).map((p) => p.slug)).toEqual(['grocer', 'jo']);
      await expect(api.upsertPlace({ name: 'Grocer 2', slug: 'grocer' })).rejects.toThrow(
        /already uses/,
      );
      await expect(api.upsertPlace({ name: 'Bad', slug: 'Bad Slug' })).rejects.toThrow(/lowercase/);
      await expect(api.upsertPlace({ name: '  ' })).rejects.toThrow(/needs a name/);
      const renamed = await api.upsertPlace({ id: thrift.id, name: 'Thrift Shop' });
      expect(renamed).toMatchObject({ name: 'Thrift Shop', slug: 'jo' }); // omitted slug is kept
    });

    it('places: tasks carry a known slug, refuse an unknown one, and a finished task keeps its place', async () => {
      await api.upsertPlace({ name: 'Grocer' });
      const t = await api.createTask({ title: 'shampoo', place: 'grocer' });
      expect(t.place).toBe('grocer');
      expect((await api.createTask({ title: 'plain' })).place).toBeNull();
      await expect(api.createTask({ title: 'x', place: 'tackle' })).rejects.toThrow(
        placeUnknownError('tackle'),
      );
      const before = (await api.listTasks()).length;
      await expect(
        api.createTasks([
          { title: 'ok', place: 'grocer' },
          { title: 'bad', place: 'tackle' },
        ]),
      ).rejects.toThrow(placeUnknownError('tackle'));
      expect(await api.listTasks()).toHaveLength(before); // the batch wrote nothing
      const [bulk] = await api.createTasks([{ title: 'nails', place: 'grocer' }]);
      expect(bulk!.place).toBe('grocer');

      expect((await api.setTaskPlace(t.id, null)).place).toBeNull();
      await expect(api.setTaskPlace(t.id, 'tackle')).rejects.toThrow(placeUnknownError('tackle'));
      expect((await api.setTaskPlace(t.id, 'grocer')).place).toBe('grocer'); // open: any time
      // A finished task's place is history — on or off a list would flip its calibration after the fact.
      await api.transitionTask(bulk!.id, 'in_progress');
      await api.transitionTask(bulk!.id, 'done');
      await api.upsertPlace({ name: 'Tackle' });
      await expect(api.setTaskPlace(bulk!.id, null)).rejects.toThrow(PLACE_FINISHED_ERROR);
      await expect(api.setTaskPlace(bulk!.id, 'tackle')).rejects.toThrow(PLACE_FINISHED_ERROR);
      const plain = await api.createTask({ title: 'plain, cancelled' });
      await api.transitionTask(plain.id, 'cancelled');
      await expect(api.setTaskPlace(plain.id, 'grocer')).rejects.toThrow(PLACE_FINISHED_ERROR);
      expect((await api.getTask(bulk!.id))!.place).toBe('grocer');
      expect((await api.getTask(plain.id))!.place).toBeNull();
    });

    it('places: a slug change follows its tasks; delete moves them to a place or off any list', async () => {
      const grocer = await api.upsertPlace({ name: 'Grocer' });
      const tackle = await api.upsertPlace({ name: 'Tackle' });
      const a = await api.createTask({ title: 'a', place: 'grocer' });
      await api.upsertPlace({ id: grocer.id, name: 'Grocer', slug: 'gr' });
      expect((await api.getTask(a.id))!.place).toBe('gr');

      await expect(api.deletePlace(grocer.id, 'nowhere')).rejects.toThrow(
        placeUnknownError('nowhere'),
      );
      await expect(api.deletePlace(grocer.id, 'gr')).rejects.toThrow(); // not onto itself
      await api.deletePlace(grocer.id, 'tackle');
      expect((await api.getTask(a.id))!.place).toBe('tackle');
      expect((await api.listPlaces()).map((p) => p.slug)).toEqual(['tackle']);

      await api.deletePlace(tackle.id, null);
      expect((await api.getTask(a.id))!.place).toBeNull();
      expect(await api.listPlaces()).toEqual([]);
    });

    it("places: delete touches only that place's tasks", async () => {
      const grocer = await api.upsertPlace({ name: 'Grocer' });
      await api.upsertPlace({ name: 'Tackle' });
      await api.upsertPlace({ name: 'Counter' });
      const s = await api.createTask({ title: 's', place: 'grocer' });
      const t = await api.createTask({ title: 't', place: 'tackle' });
      const c = await api.createTask({ title: 'c', place: 'counter' });
      const none = await api.createTask({ title: 'none' });
      await api.deletePlace(grocer.id, 'tackle');
      expect((await api.getTask(s.id))!.place).toBe('tackle');
      expect((await api.getTask(t.id))!.place).toBe('tackle');
      expect((await api.getTask(c.id))!.place).toBe('counter');
      expect((await api.getTask(none.id))!.place).toBeNull();
    });

    it('places: a finished errand stays placed through a rename, a move and a delete to none', async () => {
      const grocer = await api.upsertPlace({ name: 'Grocer' });
      const tackle = await api.upsertPlace({ name: 'Tackle' });
      const open = await api.createTask({ title: 'open', place: 'grocer' });
      const done = await api.createTask({ title: 'done', place: 'grocer', estimateMin: 5 });
      await api.transitionTask(done.id, 'in_progress');
      await api.transitionTask(done.id, 'done');
      const gone = await api.createTask({ title: 'gone', place: 'grocer' });
      await api.transitionTask(gone.id, 'cancelled');
      const points = async () =>
        (await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' })).map((p) => p.taskId);
      expect(await points()).not.toContain(done.id);

      // A slug rename and a move to another place rewrite finished tasks too — they stay placed.
      await api.upsertPlace({ id: grocer.id, name: 'Grocer', slug: 'gr' });
      expect((await api.getTask(done.id))!.place).toBe('gr');
      await api.deletePlace(grocer.id, 'tackle');
      expect((await api.getTask(done.id))!.place).toBe('tackle');
      expect((await api.getTask(gone.id))!.place).toBe('tackle');
      expect((await api.getTask(open.id))!.place).toBe('tackle');

      // Off any list: the open errand leaves it; the finished ones keep the old slug as history.
      await api.deletePlace(tackle.id, null);
      expect((await api.getTask(open.id))!.place).toBeNull();
      expect((await api.getTask(done.id))!.place).toBe('tackle');
      expect((await api.getTask(gone.id))!.place).toBe('tackle');
      expect(await points()).not.toContain(done.id); // calibration never flipped
    });

    it('places: a deleted place can be neither updated nor deleted again', async () => {
      const grocer = await api.upsertPlace({ name: 'Grocer' });
      await api.deletePlace(grocer.id, null);
      await expect(api.upsertPlace({ id: grocer.id, name: 'Back' })).rejects.toThrow();
      await expect(api.deletePlace(grocer.id, null)).rejects.toThrow();
      expect(await api.listPlaces()).toEqual([]);
    });

    it('places: a rename onto a slug in use is refused, and changes nothing', async () => {
      const grocer = await api.upsertPlace({ name: 'Grocer' });
      advance(1); // add order is createdAt (see above)
      await api.upsertPlace({ name: 'Tackle' });
      const a = await api.createTask({ title: 'a', place: 'grocer' });
      await expect(
        api.upsertPlace({ id: grocer.id, name: 'Grocer', slug: 'tackle' }),
      ).rejects.toThrow(/already uses/);
      expect((await api.listPlaces()).map((p) => p.slug)).toEqual(['grocer', 'tackle']);
      expect((await api.getTask(a.id))!.place).toBe('grocer');
    });

    it("places: a part is created on its parent's place, and refuses a different one", async () => {
      await api.upsertPlace({ name: 'Grocer' });
      await api.upsertPlace({ name: 'Tackle' });
      const party = await api.createTask({ title: 'party', place: 'grocer' });
      const cups = await api.createTask({ title: 'cups', parentId: party.id });
      expect(cups.place).toBe('grocer');
      const same = await api.createTask({ title: 'ice', parentId: party.id, place: 'grocer' });
      expect(same.place).toBe('grocer');
      await expect(
        api.createTask({ title: 'x', parentId: party.id, place: 'tackle' }),
      ).rejects.toThrow(PLACE_PART_ERROR);
      const before = (await api.listTasks()).length;
      await expect(
        api.createTasks([
          { title: 'ok', parentId: party.id },
          { title: 'bad', parentId: party.id, place: 'tackle' },
        ]),
      ).rejects.toThrow(PLACE_PART_ERROR);
      expect(await api.listTasks()).toHaveLength(before); // the batch wrote nothing
      const [bulk] = await api.createTasks([{ title: 'napkins', parentId: party.id }]);
      expect(bulk!.place).toBe('grocer');
      // An unplaced parent's parts are unplaced: a slug on one is refused too.
      const plain = await api.createTask({ title: 'pset' });
      expect((await api.createTask({ title: 'q1', parentId: plain.id })).place).toBeNull();
      await expect(
        api.createTask({ title: 'q2', parentId: plain.id, place: 'grocer' }),
      ).rejects.toThrow(PLACE_PART_ERROR);
    });

    it('places: a part follows its parent — refused on its own, carried when the parent moves', async () => {
      await api.upsertPlace({ name: 'Grocer' });
      await api.upsertPlace({ name: 'Tackle' });
      const party = await api.createTask({ title: 'party', place: 'grocer' });
      const cups = await api.createTask({ title: 'cups', parentId: party.id });
      const ice = await api.createTask({ title: 'ice', parentId: party.id });
      await api.transitionTask(ice.id, 'in_progress');
      await api.transitionTask(ice.id, 'done');
      await expect(api.setTaskPlace(cups.id, 'tackle')).rejects.toThrow(PLACE_PART_ERROR);
      await expect(api.setTaskPlace(cups.id, null)).rejects.toThrow(PLACE_PART_ERROR);
      expect((await api.setTaskPlace(party.id, 'tackle')).place).toBe('tackle');
      expect((await api.getTask(cups.id))!.place).toBe('tackle'); // open: carried along
      expect((await api.getTask(ice.id))!.place).toBe('grocer'); // finished: history
      await api.setTaskPlace(party.id, null);
      expect((await api.getTask(cups.id))!.place).toBeNull();
      expect((await api.getTask(ice.id))!.place).toBe('grocer');
    });

    it("places: attaching an open task gives it the parent's place; detaching keeps it", async () => {
      await api.upsertPlace({ name: 'Grocer' });
      await api.upsertPlace({ name: 'Tackle' });
      const party = await api.createTask({ title: 'party', place: 'grocer' });
      await api.createTask({ title: 'cups', parentId: party.id });
      const loose = await api.createTask({ title: 'ice', place: 'tackle' });
      expect((await api.setTaskParent(loose.id, party.id)).place).toBe('grocer');
      expect((await api.setTaskParent(loose.id, null)).place).toBe('grocer');
      const unplaced = await api.createTask({ title: 'plates' });
      expect((await api.setTaskParent(unplaced.id, party.id)).place).toBe('grocer');
      const plain = await api.createTask({ title: 'pset' });
      expect((await api.setTaskParent(loose.id, plain.id)).place).toBeNull(); // an unplaced parent's
    });

    it("places: a split keeps every part on the parent's place", async () => {
      await api.upsertPlace({ name: 'Grocer' });
      const big = await api.createTask({ title: 'big shop', place: 'grocer', estimateMin: 30 });
      const { parent, original, followUp } = await api.splitTask(big.id, {
        finish: 'keep',
        followUp: { title: 'rest of the shop', estimateMin: 10 },
      });
      expect([parent.place, original.place, followUp.place]).toEqual([
        'grocer',
        'grocer',
        'grocer',
      ]);
      const again = await api.splitTask(followUp.id, {
        finish: 'keep',
        followUp: { title: 'last bits', estimateMin: 5 },
      });
      expect(again.followUp.place).toBe('grocer');
    });

    it('places: the digest lists items — a parent with open parts gives way to them', async () => {
      await api.upsertPlace({ name: 'Grocer' });
      const party = await api.createTask({ title: 'party', place: 'grocer' });
      clock += 1000;
      await api.createTask({ title: 'cups', parentId: party.id });
      clock += 1000;
      await api.createTask({ title: 'ice', parentId: party.id });
      clock += 1000;
      await api.createTask({ title: 'shampoo', place: 'grocer' });
      expect((await api.listPlaceTasks('grocer')).titles).toEqual(['cups', 'ice', 'shampoo']);
      for (const p of (await api.listTasks()).filter((t) => t.parentId === party.id)) {
        await api.transitionTask(p.id, 'in_progress');
        await api.transitionTask(p.id, 'done');
      }
      // Every part finished: the parent is the item again.
      expect((await api.listPlaceTasks('grocer')).titles).toEqual(['party', 'shampoo']);
    });

    it("places: listPlaceTasks is the Shortcut's digest of open errands, oldest first", async () => {
      await api.upsertPlace({ name: 'Grocer' });
      expect(await api.listPlaceTasks('grocer')).toEqual({
        place: 'Grocer',
        slug: 'grocer',
        count: 0,
        titles: [],
        text: '',
      });
      await api.createTask({ title: 'shampoo', place: 'grocer' });
      clock += 1000;
      const nails = await api.createTask({ title: 'nails', place: 'grocer' });
      clock += 1000;
      const gone = await api.createTask({ title: 'gone', place: 'grocer' });
      await api.transitionTask(gone.id, 'cancelled');
      expect(await api.listPlaceTasks('grocer')).toMatchObject({
        count: 2,
        titles: ['shampoo', 'nails'],
        text: 'Grocer · 2 — shampoo, nails',
      });
      await api.transitionTask(nails.id, 'in_progress');
      await api.transitionTask(nails.id, 'done');
      expect((await api.listPlaceTasks('grocer')).titles).toEqual(['shampoo']);
      await expect(api.listPlaceTasks('tackle')).rejects.toThrow(placeUnknownError('tackle'));
    });

    it('places: an errand never becomes a calibration point, even with an estimate', async () => {
      await api.upsertPlace({ name: 'Grocer' });
      const errand = await api.createTask({ title: 'shampoo', place: 'grocer', estimateMin: 5 });
      const work = await api.createTask({ title: 'pset', estimateMin: 60 });
      await api.setTaskActual(work.id, 45);
      for (const t of [errand, work]) {
        await api.transitionTask(t.id, 'in_progress');
        await api.transitionTask(t.id, 'done');
      }
      const ids = (await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' })).map(
        (p) => p.taskId,
      );
      expect(ids).toEqual([work.id]);
    });

    it('places: the Shortcut token is shown once, rotates, revokes, and is never exported', async () => {
      expect(await api.getPlaceTokenStatus()).toEqual({
        active: false,
        createdAt: null,
        lastUsedAt: null,
        hint: null,
        readsToday: 0,
      });
      const first = await api.rotatePlaceToken();
      expect(first.token.startsWith(PLACE_TOKEN_PREFIX)).toBe(true);
      expect(first.token.length).toBeGreaterThan(40);
      expect(first.status).toMatchObject({ active: true, createdAt: clock, lastUsedAt: null });
      expect(first.status.hint).toBe(first.token.slice(-4));
      expect(await api.getPlaceTokenStatus()).toEqual(first.status);
      const second = await api.rotatePlaceToken();
      expect(second.token).not.toBe(first.token);
      await api.upsertPlace({ name: 'Grocer' });
      const data = JSON.stringify(await api.exportData());
      expect(data).not.toContain(second.token);
      expect(data).not.toContain(first.token);
      expect((await api.exportData()).places.map((p) => p.slug)).toEqual(['grocer']);
      await api.revokePlaceToken();
      expect((await api.getPlaceTokenStatus()).active).toBe(false);
    });

    it('scoped tokens: named, shown once, capped per scope, revocable, never exported', async () => {
      expect(await api.listScopedTokens('capture')).toEqual([]);
      const a = await api.mintScopedToken('capture', ' iPhone ');
      expect(a.token.startsWith(SCOPED_TOKEN_PREFIX.capture)).toBe(true);
      expect(a.token).toMatch(/^apc_[A-Za-z0-9_-]{43}$/);
      expect(a.info).toEqual({
        id: a.info.id,
        scope: 'capture',
        name: 'iPhone',
        hint: a.token.slice(-4),
        createdAt: clock,
        lastUsedAt: null,
        usedToday: 0,
      });
      advance(1000);
      const b = await api.mintScopedToken('capture', 'Raycast');
      expect(b.token).not.toBe(a.token);
      expect(b.info.id).not.toBe(a.info.id);
      await expect(api.mintScopedToken('capture', 'IPHONE')).rejects.toThrow('already called');
      await expect(api.mintScopedToken('capture', '  ')).rejects.toThrow('needs a name');
      await expect(api.mintScopedToken('capture', 'x'.repeat(41))).rejects.toThrow('at most 40');
      expect(await api.listScopedTokens('capture')).toEqual([a.info, b.info]);

      for (let i = 2; i < SCOPED_TOKENS_MAX; i++) {
        advance(1);
        await api.mintScopedToken('capture', `t${i}`);
      }
      await expect(api.mintScopedToken('capture', 'one more')).rejects.toThrow(
        `At most ${SCOPED_TOKENS_MAX}`,
      );
      const data = JSON.stringify(await api.exportData());
      expect(data).not.toContain(a.token);
      expect(data).not.toContain(b.token);

      await api.revokeScopedToken(a.info.id);
      await api.revokeScopedToken(a.info.id); // already gone: a no-op
      const left = await api.listScopedTokens('capture');
      expect(left.map((t) => t.name)).toEqual(['Raycast', 't2', 't3', 't4']);
      // The name and the slot are free again.
      expect((await api.mintScopedToken('capture', 'iPhone')).info.name).toBe('iPhone');
    });

    it('reminders: subscribing the same endpoint twice is one device; unsubscribe removes it', async () => {
      const status = await api.getPushStatus();
      expect(status.configured).toBe(true);
      expect(status.vapidPublicKey).toBeTruthy();
      expect(status.devices).toEqual([]);
      expect(status.removedDeviceIds).toEqual([]);
      const a = await api.subscribePush(pushSub());
      expect(a).toMatchObject({
        label: 'iPhone · Safari',
        createdAt: clock,
        lastOkAt: null,
        lastError: null,
      });
      advance(1000);
      const again = await api.subscribePush({ ...pushSub(), label: 'iPhone · Safari (again)' });
      expect(again.id).toBe(a.id);
      const b = await api.subscribePush(pushSub('https://fcm.googleapis.com/fcm/send/dev-2'));
      expect(b.id).not.toBe(a.id);
      expect((await api.getPushStatus()).devices.map((d) => d.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      await api.unsubscribePush(a.id);
      const after = await api.getPushStatus();
      expect(after.devices.map((d) => d.id)).toEqual([b.id]);
      expect(after.removedDeviceIds).toEqual([a.id]); // the removed device stops, not re-adds
      await api.unsubscribePush(a.id); // removing twice is a no-op
      await api.unsubscribePush('nope'); // so is an unknown id
      expect((await api.getPushStatus()).devices).toHaveLength(1);
      expect((await api.getPushStatus()).removedDeviceIds).toEqual([a.id]);
      const back = await api.subscribePush(pushSub()); // Enable again revives it
      expect(back.id).toBe(a.id);
      expect((await api.getPushStatus()).removedDeviceIds).toEqual([]);
    });

    it('reminders: refuses an endpoint off the push-service allowlist, and writes nothing', async () => {
      for (const bad of [
        'https://evil.example/x',
        'http://web.push.apple.com/x',
        'https://user:pw@web.push.apple.com/x',
        'https://web.push.apple.com:8443/x',
        'https://web.push.apple.com.evil.example/x',
        'not a url',
        `https://web.push.apple.com/${'a'.repeat(PUSH_ENDPOINT_MAX)}`, // over-long
      ])
        await expect(api.subscribePush(pushSub(bad))).rejects.toThrow(PUSH_ENDPOINT_ERROR);
      expect((await api.getPushStatus()).devices).toEqual([]);
    });

    it('reminders: refuses missing, empty or over-long keys; cleans and clips the label', async () => {
      const keyless = [
        undefined,
        { p256dh: 'BPk-p256dh-sample', auth: '' },
        { p256dh: '', auth: 'auth-sample' },
        { p256dh: 'x'.repeat(PUSH_KEY_MAX + 1), auth: 'auth-sample' },
      ];
      for (const keys of keyless)
        await expect(
          api.subscribePush({ ...pushSub(), keys } as unknown as SubscribePushInput),
        ).rejects.toThrow(PUSH_KEYS_ERROR);
      expect((await api.getPushStatus()).devices).toEqual([]);
      const messy = await api.subscribePush({ ...pushSub(), label: '  iPhone \n ·  Safari ' });
      expect(messy.label).toBe('iPhone · Safari');
      const long = await api.subscribePush({ ...pushSub(), label: 'x'.repeat(200) });
      expect(long.label).toHaveLength(PUSH_LABEL_MAX);
      expect((await api.subscribePush({ ...pushSub(), label: '   ' })).label).toBe('This device');
    });

    it('reminders: unsubscribing with no id refuses; removed ids read sorted', async () => {
      await expect(api.unsubscribePush('')).rejects.toThrow(PUSH_UNKNOWN_DEVICE_ERROR);
      const ids: string[] = [];
      for (const n of [1, 2, 3])
        ids.push((await api.subscribePush(pushSub(`https://web.push.apple.com/QGsort-${n}`))).id);
      for (const id of [...ids].reverse()) await api.unsubscribePush(id);
      expect((await api.getPushStatus()).removedDeviceIds).toEqual([...ids].sort());
    });

    it("reminders: a device's keys never leave — not in status, not in the export", async () => {
      await api.subscribePush(pushSub());
      const status = JSON.stringify(await api.getPushStatus());
      const data = JSON.stringify(await api.exportData());
      for (const leaked of ['BPk-p256dh-sample', 'auth-sample', 'QGdev-1']) {
        expect(status).not.toContain(leaked);
        expect(data).not.toContain(leaked);
      }
    });

    it('reminders: a test push needs a device, then queues', async () => {
      await expect(api.sendTestPush()).rejects.toThrow(PUSH_NO_DEVICE_ERROR);
      await api.subscribePush(pushSub());
      await expect(api.sendTestPush()).resolves.toBeUndefined();
    });

    // --- Flux weekly note (D62) ----------------------------------------------
    describe('lc sittings', () => {
      it('start refuses without a linked roll, writing nothing', async () => {
        await expect(api.lcSittingStart(sittingStart())).rejects.toThrow(LC_ROLL_UNLINKED_ERROR);
        expect(await api.listSittings()).toEqual([]);
        expect(await api.listTasks()).toEqual([]);
      });

      it('start attaches the open rep, starts it, titles it, and stores the problem', async () => {
        const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
        await api.updateSettings({ leetcodeRollId: roll.id });
        const { task: picked } = await api.pickRollToday(roll.id, '2023-11-14');
        const { sitting, resumed } = await api.lcSittingStart(
          sittingStart({ problem: { titleSlug: 'two-sum', difficulty: 'Easy' } }),
        );
        expect(resumed).toBe(false);
        expect(sitting).toMatchObject({
          repTaskId: picked.id,
          rollId: roll.id,
          status: 'active',
          day: '2023-11-14',
          problemSlug: 'two-sum',
          prepTarget: 'General',
          endedAt: null,
          startedAt: LC_T0,
        });
        const rep = await api.getTask(picked.id);
        expect(rep).toMatchObject({ status: 'in_progress', title: 'LeetCode · Two Sum' });
        const detail = await api.getSitting(sitting.id);
        expect(detail.problem).toMatchObject({ slug: 'two-sum', raw: { difficulty: 'Easy' } });
        expect(detail.live).toBeNull();
        expect((await api.listSittings()).map((x) => x.id)).toEqual([sitting.id]);
      });

      it('start spawns a fresh rep on the plan when none is open, and resumes on a repeat', async () => {
        const first = await startSitting(api);
        const rep = await api.getTask(first.sitting.repTaskId);
        expect(rep).toMatchObject({ status: 'in_progress', rollId: first.roll.id });
        const plans = await api.listPlansForDay(first.sitting.day);
        expect(plans.map((p) => p.taskId)).toContain(rep!.id);
        const again = await api.lcSittingStart(
          sittingStart({ clientSittingId: first.sitting.clientSittingId }),
        );
        expect(again.resumed).toBe(true);
        expect(again.sitting.id).toBe(first.sitting.id);
        // The same problem still open resumes it too (the extension lost its memory of the Start).
        const same = await api.lcSittingStart(sittingStart());
        expect(same).toMatchObject({ resumed: true, sitting: { id: first.sitting.id } });
        expect((await api.listTasks()).filter((t) => t.rollId === first.roll.id)).toHaveLength(1);
      });

      it('start on another problem is refused while a sitting is open, and spawns after Done', async () => {
        const { sitting } = await startSitting(api);
        await expect(
          api.lcSittingStart(
            sittingStart({ problemSlug: 'add-two-numbers', problemTitle: 'Add Two' }),
          ),
        ).rejects.toThrow(SITTING_ACTIVE_ERROR);
        await api.setTaskActual(sitting.repTaskId, 40);
        await api.transitionTask(sitting.repTaskId, 'done');
        const ended = (await api.getSitting(sitting.id)).sitting;
        expect(ended.status).toBe('done');
        expect(ended.endedAt).not.toBeNull();
        const next = await api.lcSittingStart(
          sittingStart({ problemSlug: 'add-two-numbers', problemTitle: 'Add Two' }),
        );
        expect(next.sitting.repTaskId).not.toBe(sitting.repTaskId);
        expect(await api.getTask(next.sitting.repTaskId)).toMatchObject({
          status: 'in_progress',
          title: 'LeetCode · Add Two',
        });
      });

      it('snapshots version the live code, newest wins, and repeats are duplicates', async () => {
        const { sitting } = await startSitting(api);
        const a = lcSnap('class Solution: pass', LC_T0 + 60_000);
        const b = lcSnap('class Solution:\n    def twoSum(self): ...', LC_T0 + 120_000);
        const older = lcSnap('stale', LC_T0 + 90_000);
        const r1 = await api.lcSittingEvents({ sittingId: sitting.id, events: [a, b] });
        expect(r1).toEqual({
          accepted: 2,
          duplicates: 0,
          skipped: 0,
          version: 2,
          status: 'active',
        });
        const r2 = await api.lcSittingEvents({ sittingId: sitting.id, events: [a, older] });
        expect(r2).toMatchObject({ accepted: 1, duplicates: 1, version: 3 });
        const { live, events } = await api.getSitting(sitting.id);
        expect(live).toMatchObject({
          version: 3,
          code: 'class Solution:\n    def twoSum(self): ...',
        });
        expect(events.map((e) => e.type)).toEqual(['snapshot', 'snapshot', 'snapshot']);
        expect(events.map((e) => e.at)).toEqual([LC_T0 + 60_000, LC_T0 + 90_000, LC_T0 + 120_000]);
      });

      it('runs and submits fold into the metrics; Accepted does not end the sitting', async () => {
        const { sitting } = await startSitting(api);
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [
            lcJudged('run', 15, 'Runtime Error', LC_T0 + 5 * 60_000, 0, 3),
            lcJudged('submit', 11, 'Wrong Answer', LC_T0 + 30 * 60_000, 88, 307),
            lcJudged('submit', 10, 'Accepted', LC_T0 + 32 * 60_000, 307, 307),
          ],
        });
        const s = (await api.getSitting(sitting.id)).sitting;
        expect(s.status).toBe('active');
        expect(s.summary).toMatchObject({
          runs: 1,
          submits: 2,
          runsBeforeFirstSubmit: 1,
          firstSubmit: { verdict: 'wrong_answer', passed: 88, total: 307 },
          lastSubmit: { verdict: 'accepted' },
          lastRun: { verdict: 'runtime_error' },
          firstAcceptedAt: LC_T0 + 32 * 60_000,
          submitsBeforeAccepted: 1,
        });
        expect(sittingMetrics(s)).toEqual({
          firstSubmitAccepted: false,
          submitsBeforeAccepted: 1,
          timeToFirstSubmitMs: 30 * 60_000,
        });
      });

      it('replay is stored raw, kept out of getSitting, and folds into the facts', async () => {
        const { sitting } = await startSitting(api);
        const replay = JSON.stringify([
          { type: 7, timestamp: LC_T0 + 1000 },
          { type: 3, val: true, timestamp: LC_T0 + 2000 },
          { type: 7, timestamp: LC_T0 + 61_000 },
        ]);
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [
            {
              id: ulid(),
              type: 'replay',
              at: LC_T0 + 61_000,
              clientSessionId: 'p-1',
              events: replay,
            },
          ],
        });
        const { live, events } = await api.getSitting(sitting.id);
        expect(events).toEqual([]);
        expect(live?.facts).toMatchObject({
          edits: 2,
          firstEditAt: LC_T0 + 1000,
          longestStallMs: 60_000,
          focus: [[LC_T0 + 2000, true]],
        });
        const chunks = await api.listSittingReplay(sitting.id);
        expect(chunks.map((c) => c.events)).toEqual([replay]);
      });

      it('a timer read lands on the summary', async () => {
        const { sitting } = await startSitting(api);
        const state = {
          mode: 'reverse',
          startTimestamp: null,
          pauseMs: 60_000,
          endMs: 3_600_000,
          status: 'pause',
        };
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [{ id: ulid(), type: 'timer', at: LC_T0 + 70_000, payload: { state } }],
        });
        expect((await api.getSitting(sitting.id)).sitting.summary.lcTimer).toMatchObject({
          mode: 'reverse',
          status: 'pause',
          elapsedMs: 60_000,
        });
      });

      it('events refuse bad input, unknown and ended sittings, with nothing written', async () => {
        const { sitting } = await startSitting(api);
        const huge = lcSnap('x'.repeat(70 * 1024), LC_T0 + 1000);
        await expect(
          api.lcSittingEvents({ sittingId: sitting.id, events: [huge] }),
        ).rejects.toThrow(/too large/);
        const many = Array.from({ length: 51 }, (_, i) => lcSnap('a', LC_T0 + i));
        await expect(api.lcSittingEvents({ sittingId: sitting.id, events: many })).rejects.toThrow(
          /At most 50/,
        );
        await expect(
          api.lcSittingEvents({
            sittingId: sitting.id,
            events: [{ ...lcSnap('a', LC_T0), id: 'nope' }],
          }),
        ).rejects.toThrow(/valid id/);
        await expect(
          api.lcSittingEvents({ sittingId: ulid(), events: [lcSnap('a', LC_T0)] }),
        ).rejects.toThrow(/Not found/);
        expect((await api.getSitting(sitting.id)).live).toBeNull();
        await api.transitionTask(sitting.repTaskId, 'cancelled');
        expect((await api.getSitting(sitting.id)).sitting.status).toBe('abandoned');
        advance(SITTING_END_GRACE_MS + 1);
        await expect(
          api.lcSittingEvents({ sittingId: sitting.id, events: [lcSnap('a', LC_T0)] }),
        ).rejects.toThrow(SITTING_ENDED_ERROR);
      });

      it('events stop a day after Start', async () => {
        const { sitting } = await startSitting(api);
        advance(SITTING_INGEST_WINDOW_MS + 1);
        await expect(
          api.lcSittingEvents({ sittingId: sitting.id, events: [lcSnap('a', LC_T0)] }),
        ).rejects.toThrow(SITTING_ENDED_ERROR);
      });

      // The outbox's retries land after Done: what was stamped before the end still counts, for a while.
      it('an event stamped before the end still lands for ten minutes; one stamped after is skipped', async () => {
        const { sitting } = await startSitting(api);
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [lcSnap('first', LC_T0 + 1000)],
        });
        advance(5 * 60_000);
        await api.setTaskActual(sitting.repTaskId, 5);
        await api.transitionTask(sitting.repTaskId, 'done');
        const endedAt = (await api.getSitting(sitting.id)).sitting.endedAt!;
        const rep = await api.getTask(sitting.repTaskId);
        advance(2 * 60_000);
        const before = [
          lcSnap('final', LC_T0 + 4 * 60_000),
          lcJudged('submit', 10, 'Accepted', LC_T0 + 4 * 60_000 + 1, 3, 3),
        ];
        const after = lcSnap('after', endedAt + SITTING_END_SKEW_MS + 1);
        const call = (events: SittingEventInput[]) =>
          api.lcSittingEvents({ sittingId: sitting.id, events });
        expect(await call([...before, after])).toEqual({
          accepted: 2,
          duplicates: 0,
          skipped: 1,
          version: 2,
          status: 'done',
        });
        const got = await api.getSitting(sitting.id);
        expect(got.sitting).toMatchObject({
          status: 'done',
          endedAt,
          summary: { submits: 1, lastSubmit: { verdict: 'accepted' } },
        });
        expect(got.live).toMatchObject({ code: 'final', version: 2 });
        expect(got.events.map((e) => e.id)).not.toContain(after.id);
        expect(await api.getTask(sitting.repTaskId)).toEqual(rep);
        expect(await call([...before, after])).toEqual({
          accepted: 0,
          duplicates: 2,
          skipped: 1,
          version: 2,
          status: 'done',
        });
        const settled = await api.getSitting(sitting.id);
        expect(await call([lcSnap('later', endedAt + 2 * 60_000)])).toMatchObject({
          accepted: 0,
          skipped: 1,
          version: 2,
        });
        expect(await api.getSitting(sitting.id)).toEqual(settled); // nothing written
        advance(SITTING_END_GRACE_MS - 2 * 60_000); // the grace's last moment
        const note = {
          id: ulid(),
          type: 'note' as const,
          at: LC_T0 + 2000,
          payload: { text: 'n' },
        };
        expect(await call([note])).toMatchObject({ accepted: 1, status: 'done' });
        advance(1);
        await expect(call([lcSnap('gone', LC_T0 + 3000)])).rejects.toThrow(SITTING_ENDED_ERROR);
      });

      it('the grace is measured on the extension’s clock', async () => {
        const H = 3600_000;
        const { sitting } = await startSitting(api, { startedAt: LC_T0 - 3 * H }); // the laptop 3 h behind
        advance(10 * 60_000);
        await api.setTaskActual(sitting.repTaskId, 10);
        await api.transitionTask(sitting.repTaskId, 'done');
        const r = await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [
            lcSnap('before', LC_T0 - 3 * H + 9 * 60_000),
            lcSnap('after', LC_T0 - 3 * H + 10 * 60_000 + SITTING_END_SKEW_MS + 1),
            lcSnap('server', LC_T0 + 5 * 60_000), // before the end on the server's clock only
          ],
        });
        expect(r).toMatchObject({ accepted: 1, skipped: 2, status: 'done' });
        expect((await api.getSitting(sitting.id)).live?.code).toBe('before');
      });

      it('a dropped sitting takes late events the same', async () => {
        const { sitting } = await startSitting(api);
        advance(5 * 60_000);
        await api.transitionTask(sitting.repTaskId, 'cancelled');
        const { endedAt } = (await api.getSitting(sitting.id)).sitting;
        const r = await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [
            lcJudged('run', 15, 'Runtime Error', LC_T0 + 60_000, 0, 3),
            lcSnap('after', endedAt! + SITTING_END_SKEW_MS + 1),
          ],
        });
        expect(r).toEqual({
          accepted: 1,
          duplicates: 0,
          skipped: 1,
          version: 0,
          status: 'abandoned',
        });
        const got = await api.getSitting(sitting.id);
        expect(got.sitting).toMatchObject({ status: 'abandoned', endedAt, summary: { runs: 1 } });
        expect(got.live).toBeNull();
      });

      it('a sitting ended past its window takes no late events', async () => {
        const { sitting } = await startSitting(api);
        advance(SITTING_INGEST_WINDOW_MS + 1);
        await api.lcSittingStart(sittingStart({ startedAt: LC_T0 + SITTING_INGEST_WINDOW_MS + 1 }));
        expect((await api.getSitting(sitting.id)).sitting).toMatchObject({
          status: 'abandoned',
          endedAt: LC_T0 + SITTING_INGEST_WINDOW_MS + 1,
        });
        await expect(
          api.lcSittingEvents({ sittingId: sitting.id, events: [lcSnap('a', LC_T0 + 1000)] }),
        ).rejects.toThrow(SITTING_ENDED_ERROR);
      });

      it('prep target is normalized, and listSittings filters by day', async () => {
        const { sitting } = await startSitting(api);
        expect((await api.setSittingPrepTarget(sitting.id, '  Nominal ')).prepTarget).toBe(
          'Nominal',
        );
        expect((await api.setSittingPrepTarget(sitting.id, '   ')).prepTarget).toBe('General');
        await expect(api.setSittingPrepTarget(sitting.id, 'x'.repeat(41))).rejects.toThrow(
          /limited/,
        );
        expect(await api.listSittings({ from: '2023-11-15', to: '2023-11-20' })).toEqual([]);
        expect(
          (await api.listSittings({ from: '2023-11-14', to: '2023-11-14' })).map((x) => x.id),
        ).toEqual([sitting.id]);
      });

      it('the capture budget counts every event type, repeats included, and refuses past the cap', async () => {
        const { sitting } = await startSitting(api);
        const details = () =>
          Array.from({ length: SITTING_EVENTS_PER_CALL }, (_, i) => ({
            id: ulid(),
            type: 'submitDetails' as const,
            at: LC_T0 + i,
            payload: { d: 1 },
          }));
        const calls = SITTING_MAX_EVENTS / SITTING_EVENTS_PER_CALL - 1;
        const last = details();
        for (let i = 0; i < calls; i++)
          await api.lcSittingEvents({ sittingId: sitting.id, events: details() });
        await api.lcSittingEvents({ sittingId: sitting.id, events: last }); // exactly at the cap
        // A repeat of the last call is all duplicates — and still refused: the budget reserves before it looks.
        await expect(api.lcSittingEvents({ sittingId: sitting.id, events: last })).rejects.toThrow(
          SITTING_CAP_ERROR,
        );
        await expect(
          api.lcSittingEvents({ sittingId: sitting.id, events: [lcSnap('a', LC_T0)] }),
        ).rejects.toThrow(SITTING_CAP_ERROR);
        expect((await api.getSitting(sitting.id)).live?.version).toBe(0); // the refused snapshot never landed
      });

      it('a sitting left open past its window ends at the next Start, which reuses its rep', async () => {
        const { sitting } = await startSitting(api);
        advance(SITTING_INGEST_WINDOW_MS + 1);
        const next = await api.lcSittingStart(
          sittingStart({ startedAt: LC_T0 + SITTING_INGEST_WINDOW_MS + 1 }),
        );
        expect(next.resumed).toBe(false);
        expect(next.sitting.repTaskId).toBe(sitting.repTaskId);
        expect((await api.getSitting(sitting.id)).sitting).toMatchObject({ status: 'abandoned' });
        expect(await api.getTask(sitting.repTaskId)).toMatchObject({ status: 'in_progress' });
      });

      it('an archived roll reads as unlinked', async () => {
        const { roll } = await startSitting(api);
        const { id, name, categoryId, estimateMin } = roll; // an input, not the stored row
        await api.upsertRoll({ id, name, categoryId, estimateMin, active: false });
        await expect(
          api.lcSittingStart(sittingStart({ problemSlug: 'three-sum', problemTitle: '3Sum' })),
        ).rejects.toThrow(LC_ROLL_UNLINKED_ERROR);
      });

      it('a timed rep is attached and started but never planned', async () => {
        const roll = await api.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
        await api.updateSettings({ leetcodeRollId: roll.id });
        const { task: picked } = await api.pickRollToday(roll.id, '2023-11-13');
        await api.setTaskDue(picked.id, { dueDay: '2023-11-14', dueTime: '18:00' });
        const { sitting } = await api.lcSittingStart(sittingStart());
        expect(sitting.repTaskId).toBe(picked.id);
        expect(await api.getTask(picked.id)).toMatchObject({ status: 'in_progress' });
        const plans = await api.listPlansForDay(sitting.day);
        expect(plans.filter((p) => p.taskId === picked.id)).toEqual([]);
      });

      it('a Start whose time is more than a day off is refused', async () => {
        await startSitting(api, { problemSlug: 'warm-up', problemTitle: 'Warm up' });
        await expect(
          api.lcSittingStart(
            sittingStart({ problemSlug: 'later', startedAt: LC_T0 + 2 * SITTING_INGEST_WINDOW_MS }),
          ),
        ).rejects.toThrow(SITTING_START_TIME_ERROR);
      });

      it('deleting the rep removes the sitting; deleteSitting is idempotent', async () => {
        const { sitting } = await startSitting(api);
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [
            lcSnap('a', LC_T0 + 1),
            lcJudged('submit', 11, 'Wrong Answer', LC_T0 + 2, 1, 3),
            {
              id: ulid(),
              type: 'timer',
              at: LC_T0 + 3,
              payload: { state: { status: 'pause', pauseMs: 9 } },
            },
          ],
        });
        await api.deleteTask(sitting.repTaskId);
        expect(await api.listSittings()).toEqual([]);
        await expect(api.getSitting(sitting.id)).rejects.toThrow(/Not found/);
        await api.deleteSitting(sitting.id); // already gone — a no-op
        const other = await api.lcSittingStart(
          sittingStart({ problemSlug: 'three-sum', problemTitle: '3Sum' }),
        );
        await api.deleteSitting(other.sitting.id);
        expect(await api.listSittings()).toEqual([]);
        expect(await api.getTask(other.sitting.repTaskId)).toMatchObject({ status: 'in_progress' }); // rep stays
      });

      // The review (setSittingReview) rides the head: normalized, whole-replaced, cleared when empty, and kept
      // by a later ingest's refold.
      it('a review saves normalized, reads back on get and list, and survives a refold', async () => {
        const { sitting } = await startSitting(api);
        const saved = await api.setSittingReview(sitting.id, {
          insight: '  two   pointers ',
          help: 'hint',
          mistakes: [' off  by one ', ''],
          howItWent: ' slow start ',
          tags: ['Two-Pointers', 'two-pointers', ' Greedy '],
          draftUsed: true,
        });
        const want = {
          insight: 'two pointers',
          help: 'hint',
          mistakes: ['off by one'],
          howItWent: 'slow start',
          tags: ['two-pointers', 'greedy'],
          draftUsed: true,
        };
        expect(saved.review).toMatchObject(want);
        expect((await api.getSitting(sitting.id)).sitting.review).toMatchObject(want);
        expect((await api.listSittings())[0]!.review).toMatchObject(want);
        // A run after the review folds into the head without losing it.
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [lcJudged('run', 11, 'Wrong Answer', LC_T0 + 60_000, 1, 3)],
        });
        const after = (await api.getSitting(sitting.id)).sitting;
        expect(after.summary.runs).toBe(1);
        expect(after.review).toMatchObject(want);
      });

      it('a second review replaces the first; saying nothing clears it', async () => {
        const { sitting } = await startSitting(api);
        const base = { insight: null, mistakes: [], howItWent: null, tags: [], draftUsed: false };
        await api.setSittingReview(sitting.id, { ...base, help: 'solution', tags: ['dp'] });
        const second = await api.setSittingReview(sitting.id, {
          ...base,
          help: 'none',
          insight: 'x',
        });
        expect(second.review).toMatchObject({ help: 'none', insight: 'x', tags: [] });
        expect(
          (await api.setSittingReview(sitting.id, { ...base, help: 'none' })).review,
        ).toBeNull();
      });

      it('an invalid review is refused, the head unchanged; an unknown sitting is Not found', async () => {
        const { sitting } = await startSitting(api);
        const ok = {
          insight: null,
          help: 'none' as const,
          mistakes: [],
          howItWent: null,
          tags: [],
          draftUsed: false,
        };
        await api.setSittingReview(sitting.id, { ...ok, insight: 'kept' });
        for (const bad of [
          { ...ok, mistakes: Array(9).fill('m') },
          { ...ok, insight: 'x'.repeat(201) },
          { ...ok, mistakes: ['m'.repeat(REVIEW_LINE_MAX + 1)] },
          { ...ok, help: 'cheat' as never },
        ])
          await expect(api.setSittingReview(sitting.id, bad)).rejects.toThrow(/limited|Help/);
        expect((await api.getSitting(sitting.id)).sitting.review?.insight).toBe('kept');
        await expect(api.setSittingReview(ulid(), { ...ok, insight: 'x' })).rejects.toThrow(
          /Not found/,
        );
      });

      // Each side answers in its own way (the stub deterministically, the Lambda's noop model as unavailable),
      // but within the contract, and neither writes.
      it('a draft writes nothing: nothing judged → nothing-to-draft; else lines within the caps or a reason', async () => {
        const { sitting } = await startSitting(api);
        expect(await api.draftSittingReview(sitting.id)).toEqual({
          ok: false,
          reason: 'nothing-to-draft',
        });
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [lcJudged('submit', 11, 'Wrong Answer', LC_T0 + 60_000, 1, 3)],
        });
        const before = await api.getSitting(sitting.id);
        const draft = await api.draftSittingReview(sitting.id);
        if (draft.ok) {
          expect(draft.mistakes.length).toBeLessThanOrEqual(DRAFT_LINES_MAX);
          for (const l of draft.mistakes) expect(l.length).toBeLessThanOrEqual(REVIEW_LINE_MAX);
        } else
          expect(['unavailable', 'timeout', 'network', 'api', 'bad-json', 'bad-shape']).toContain(
            draft.reason,
          );
        expect(await api.getSitting(sitting.id)).toEqual(before);
        await expect(api.draftSittingReview(ulid())).rejects.toThrow(/Not found/);
      });

      it('a live pull returns the open sitting’s code and newest Run and Submit, and counts itself', async () => {
        const { sitting } = await startSitting(api);
        const before = await api.pullLiveSitting(); // nothing captured yet: still the open one
        expect(before).toMatchObject({ sitting: { id: sitting.id }, live: null, lastRun: null });
        const wa = lcJudged('submit', 11, 'Wrong Answer', LC_T0 + 4 * 60_000, 1, 3);
        const ac = lcJudged('submit', 10, 'Accepted', LC_T0 + 6 * 60_000, 3, 3);
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [
            lcSnap('a', LC_T0 + 60_000),
            lcSnap('ab', LC_T0 + 2 * 60_000),
            lcJudged('run', 15, 'Runtime Error', LC_T0 + 3 * 60_000, 0, 1),
            ac, // out of order: the newest is by time, not arrival
            wa,
            lcSnap('abc', LC_T0 + 5 * 60_000),
          ],
        });
        const pull = await api.pullLiveSitting();
        expect(pull.sitting?.id).toBe(sitting.id);
        expect(pull.live).toMatchObject({ version: 3, code: 'abc' });
        expect(pull.lastSubmit?.id).toBe(ac.id);
        expect(pull.lastRun?.type).toBe('run');
        expect(pull.liveReads).toBe(2);
        expect(pull.lastSitting).toBeNull();
        // The count lives beside the head, so a refold (another submit) can't drop it.
        await api.lcSittingEvents({
          sittingId: sitting.id,
          events: [lcJudged('submit', 10, 'Accepted', LC_T0 + 7 * 60_000, 3, 3)],
        });
        expect((await api.pullLiveSitting()).liveReads).toBe(3);
        expect((await api.getSitting(sitting.id)).liveReads).toBe(3);
      });

      it('a live pull with nothing open names the last sitting and writes nothing', async () => {
        expect(await api.pullLiveSitting()).toEqual({
          sitting: null,
          live: null,
          lastRun: null,
          lastSubmit: null,
          liveReads: 0,
          lastSitting: null,
        });
        const { sitting } = await startSitting(api);
        await api.pullLiveSitting();
        await api.setTaskActual(sitting.repTaskId, 40);
        await api.transitionTask(sitting.repTaskId, 'done');
        const after = await api.pullLiveSitting();
        expect(after).toMatchObject({
          sitting: null,
          liveReads: 1,
          lastSitting: { id: sitting.id, status: 'done' },
        });
        expect((await api.getSitting(sitting.id)).liveReads).toBe(1);
        // Open past its window: read as closed, and not counted (the next Start ends it).
        advance(60_000);
        const next = await api.lcSittingStart(
          sittingStart({ problemSlug: 'three-sum', problemTitle: '3Sum', startedAt: clock }),
        );
        advance(SITTING_INGEST_WINDOW_MS + 1);
        expect(await api.pullLiveSitting()).toMatchObject({
          sitting: null,
          lastSitting: { id: next.sitting.id, status: 'active' },
          liveReads: 0,
        });
        expect((await api.getSitting(next.sitting.id)).liveReads).toBe(0);
      });
    });

    describe('flux week note', () => {
      const week = (over: Partial<RecordFluxSetInput> = {}) =>
        fluxSet({ day: dayKeyInZone(clock, USER_TIME_ZONE, 4), completedAt: clock, ...over }); // the user's day, as the Lambda reads it

      it('is null under two sets this week, then a line within the cap naming the exercise, cached until a set changes', async () => {
        expect(await api.getFluxWeekNote()).toBeNull();
        await api.recordFluxSet(week({ completedAt: clock - 2000 }));
        expect(await api.getFluxWeekNote()).toBeNull();
        const second = await api.recordFluxSet(week({ completedAt: clock - 1000 }));
        const note = await api.getFluxWeekNote();
        expect(note).not.toBeNull();
        expect(note!.weekStart).toBe(fluxWeekStart(dayKeyInZone(clock, USER_TIME_ZONE, 4)));
        expect(note!.text.length).toBeLessThanOrEqual(140);
        expect(note!.text).toContain('rotation');
        expect(await api.getFluxWeekNote()).toEqual(note); // the same note until a set is saved or deleted
        const third = await api.recordFluxSet(
          week({
            exerciseId: 'chin-tuck',
            kind: 'holdAtTarget',
            avgPeakDeg: null,
            count: 6,
            planned: 6,
          }),
        );
        const next = await api.getFluxWeekNote();
        expect(next!.text).toContain('chin tuck');
        expect(next!.text).not.toBe(note!.text);
        await api.deleteFluxSet(third.id);
        expect((await api.getFluxWeekNote())!.text).toBe(note!.text);
        await api.deleteFluxSet(second.id);
        expect(await api.getFluxWeekNote()).toBeNull(); // one set this week again
      });
    });
  });
}
