import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from './api';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TASK, UPLOAD_URL_TTL_MS } from './attachments';
import { TASK_NOTES_MAX } from './taskNotes';
import { addDays, todayKey } from './dates';
import { FINANCE_REFRESH_COOLDOWN_MS, resolveRefundLinks } from './finance';
import { FIXTURE_INSTITUTION, FIXTURE_LINK_ACCOUNTS } from './financeFixtures';

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

    it('logs: create is retrievable by its own day, and updates', async () => {
      const e = await api.createLogEntry('shipped it', '2026-08-04');
      expect(e.day).toBe('2026-08-04'); // bucketed by the client-supplied day, not a server-derived one
      const list = await api.listLogEntries(e.day);
      expect(list.map((x) => x.text)).toContain('shipped it');
      const updated = await api.updateLogEntry(e.id, 'shipped it, finally');
      expect(updated.text).toBe('shipped it, finally');
    });

    it('leetcode: record normalizes verdict, buckets by client tz, and is idempotent on submission id', async () => {
      const base = {
        problemSlug: 'two-sum',
        problemTitle: 'Two Sum',
        submittedAt: 1_700_000_000_000, // 2023-11-14T22:13:20Z
        tzOffsetMinutes: 300, // UTC-5
        lang: 'python3',
      };
      const wrong = await api.recordLeetcodeAttempt({
        ...base,
        leetcodeSubmissionId: 'sub-1',
        statusCode: 11,
        statusMsg: 'Wrong Answer',
        difficulty: 'Easy',
        topicTags: ['array', 'hash-table'],
      });
      expect(wrong.verdict).toBe('wrong_answer');
      expect(wrong.difficulty).toBe('Easy');
      expect(wrong.topicTags).toEqual(['array', 'hash-table']);
      // day = submittedAt shifted by tz offset + dayStartHour(4), via UTC getters → runner-TZ-independent
      expect(wrong.day).toBe('2023-11-14');

      // Same submission id re-fires → same row, original verdict preserved (no overwrite).
      const dup = await api.recordLeetcodeAttempt({
        ...base,
        leetcodeSubmissionId: 'sub-1',
        statusCode: 10,
        statusMsg: 'Accepted',
      });
      expect(dup.id).toBe(wrong.id);
      expect(dup.verdict).toBe('wrong_answer');

      const ac = await api.recordLeetcodeAttempt({
        ...base,
        leetcodeSubmissionId: 'sub-2',
        statusCode: 10,
        statusMsg: 'Accepted',
        submittedAt: base.submittedAt + 60_000,
      });
      const list = await api.listLeetcodeAttempts();
      expect(list).toHaveLength(2); // dup didn't add a row
      expect(list[0]!.id).toBe(ac.id); // reverse-chron: newer first
      expect(list[0]!.difficulty).toBeNull(); // unset → null, not undefined
      expect(list[0]!.verdict).toBe('accepted');
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

    it('tasks: estimate freezes on start of work and yields a calibration point when done', async () => {
      const t = await api.createTask({ title: 'Task A', estimateMin: 30, bufferMin: 8 });
      expect((await api.listBacklog()).map((x) => x.id)).toContain(t.id);

      await api.setTaskEstimate(t.id, 30, 8);
      const started = await api.transitionTask(t.id, 'in_progress');
      expect(started.estimateLockedMin).toBe(30); // frozen at start
      expect(started.startedAt).not.toBeNull();

      // Estimate is now frozen — editing it must throw for every impl.
      await expect(api.setTaskEstimate(t.id, 99, 0)).rejects.toThrow();

      await api.setTaskActual(t.id, 45);
      const done = await api.transitionTask(t.id, 'done');
      expect(done.status).toBe('done');
      expect(done.completedAt).not.toBeNull();

      const cal = await api.getCalibration({ from: '2000-01-01', to: '2100-01-01' });
      const point = cal.find((p) => p.taskId === t.id);
      expect(point?.estimateLockedMin).toBe(30);
      expect(point?.actualAccruedMin).toBe(45);
    });

    it('tasks: split finishes the original and spawns a fresh unlocked follow-up', async () => {
      const t = await api.createTask({ title: 'Big thing', estimateMin: 60, bufferMin: 0 });
      await api.transitionTask(t.id, 'in_progress');
      const { original, followUp } = await api.splitTask(t.id, 'done', 'Big thing, part 2');
      expect(original.status).toBe('done');
      expect(followUp.title).toBe('Big thing, part 2');
      expect(followUp.status).toBe('backlog');
      expect(followUp.estimateLockedMin).toBeNull(); // a new prediction, never the frozen value
      expect((await api.listTasks()).map((x) => x.id)).toEqual(
        expect.arrayContaining([original.id, followUp.id]),
      );
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
      const t = await api.createTask({ title: 'Big thing', notes: 'links + context' });
      await api.transitionTask(t.id, 'in_progress');
      const { followUp } = await api.splitTask(t.id, 'done', 'Big thing, part 2');
      expect(followUp.notes).toBe('links + context');
      const data = await api.exportData();
      expect(data.tasks.find((x) => x.id === t.id)?.notes).toBe('links + context');
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

    it('habits: check is idempotent per day and uncheck clears it', async () => {
      const h = await api.upsertHabit({ name: 'Read', categoryId: null, cadencePerWeek: 5 });
      const c1 = await api.checkHabit(h.id, '2026-08-04');
      const c2 = await api.checkHabit(h.id, '2026-08-04');
      expect(c2.id).toBe(c1.id); // one per (habit, day)
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toHaveLength(1);
      await api.uncheckHabit(h.id, '2026-08-04');
      expect(await api.listHabitChecks({ from: '2026-08-01', to: '2026-08-07' })).toHaveLength(0);
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

    it('day: a missed occurrence the series does not replace today goes to backlog', async () => {
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

    it('day: intent persists on the singleton', async () => {
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
      expect(s.financeBudgetCents).toBe(60000);
      expect(s.financePaymentDay).toBe(20);
      const fin = await api.updateSettings({ financeBudgetCents: 45000 });
      expect(fin.financeBudgetCents).toBe(45000);
    });

    // ExportBundle now catches a missing OR stray key at compile time (both impls return a checked
    // object literal), so this assertion is a runtime backstop rather than the primary guard. It still
    // earns its place: excess-property checking evaporates the moment an impl returns a variable, a
    // spread, or an `as` cast, and it can't see a declared-but-actually-undefined value or a key the
    // HTTP layer's JSON round-trip drops. Listing the collections here is deliberate double-entry —
    // don't replace it with a constant the implementations also import.
    it('export: exposes exactly the known collections, with created entities in them', async () => {
      const t = await api.createTask({ title: 'exportable' });
      const lc = await api.recordLeetcodeAttempt({
        leetcodeSubmissionId: 'sub-export',
        problemSlug: 'two-sum',
        problemTitle: 'Two Sum',
        statusCode: 10,
        submittedAt: 1_700_000_000_000,
        tzOffsetMinutes: 300,
        lang: 'python3',
      });
      const story = await api.createStory({ title: 'exportable story' });
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
          'habitChecks',
          'habits',
          'ideas',
          'leetcodeAttempts',
          'logEntries',
          'plans',
          'rolls',
          'series',
          'sessions',
          'settings',
          'stories',
          'tasks',
          'userId',
        ].sort(),
      );
      expect(data.tasks.map((x) => x.id)).toContain(t.id);
      expect(data.leetcodeAttempts.map((x) => x.id)).toContain(lc.id);
      expect(data.stories.map((x) => x.id)).toContain(story.id);
      expect(data.attachments.map((x) => x.id)).toContain(attachment.id); // ready rows only
      // Materialised, never the stub's nullable storage state — nothing in this test triggers
      // ensureSettings() beforehand, so a stub that exported store.settings raw would fail here.
      expect(data.settings).toBeTruthy();
    });

    // Soft-deleted rows stay out of the export. The two impls used to disagree — the stub spread its
    // raw store (tombstones included), the backend's repo reads are alive()-filtered (excluded) — and
    // no type can catch that, since both are well-typed arrays of the same element. Two probes because
    // they take different paths: deleteCategory writes deletedAt via putCategory, removePlan goes
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
    // day, and both run the sync inline here (stub: in-process; lambda: InlineInvoker + InMemoryPlaid),
    // so the whole connect → sync → sort loop is compared end to end.
    const finToday = () => todayKey(4, clock);
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
      expect(o.budgetCents).toBe(60000);
      expect(o.leftCents).toBe(60000);
      expect(o.unsortedCount).toBe(0);
      expect(o.sync.lastSyncedAt).toBeNull();
      expect([o.sync.lastError, o.sync.lastErrorAt]).toEqual([null, null]);
    });

    it('finance: connect → sync → list → bucket → overview', async () => {
      const link = await api.createPlaidLinkToken({ mode: 'connect' });
      expect(link.linkToken).toBeTruthy();
      const item = await connect();
      expect(item.institutionName).toBe('Bank of America');
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
      expect(after.leftCents).toBe(60000 - total);
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
      expect(before.spentCents).toBe(3499);

      const linked = await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
      expect(linked.refundOfId).toBe('fx-card-8');
      expect(linked.bucket).toBeNull();
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.spentCents).toBe(0);
      expect(after.unsortedCount).toBe(before.unsortedCount - 1);

      await api.linkFinanceRefund('fx-refund-1', null);
      const unlinked = await api.getFinanceOverview({ today: finToday() });
      expect(unlinked.spentCents).toBe(3499);
      expect(unlinked.unsortedCount).toBe(before.unsortedCount);
    });

    it('finance: a partial refund nets partially and follows the charge into its period', async () => {
      await connect();
      await api.linkFinanceRefund('fx-refund-2', 'fx-card-14');
      await api.setFinanceBucket({ ids: ['fx-card-14'], bucket: 'budget' });
      // The charge is in the previous period — so is its refund, though it's dated this period.
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(0);
      await api.setFinancePeriodOverride('fx-card-14', 'current');
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(2689 - 1000);
    });

    it('finance: refund link validation', async () => {
      await connect();
      await expect(api.linkFinanceRefund('fx-card-8', 'fx-card-2')).rejects.toThrow(); // charge as refund
      await expect(api.linkFinanceRefund('fx-refund-1', 'fx-refund-2')).rejects.toThrow(); // onto a credit
      await expect(api.linkFinanceRefund('fx-refund-1', 'fx-refund-1')).rejects.toThrow(); // self
      await expect(api.linkFinanceRefund('fx-refund-2', 'fx-card-10')).rejects.toThrow(); // $10 > $6.75
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

    it('finance: a refund link survives its charge going pending→posted', async () => {
      await connect();
      await api.linkFinanceRefund('fx-refund-2', 'fx-pending-1');
      await api.setFinanceBucket({ ids: ['fx-pending-1'], bucket: 'parents_pay' });
      advance(1000);
      await api.requestFinanceSync({ refresh: false });
      const txns = await api.listFinanceTransactions(await finRange());
      expect(resolveRefundLinks(txns).get('fx-refund-2')?.id).toBe('fx-posted-1');
      const o = await api.getFinanceOverview({ today: finToday() });
      expect(o.buckets.parents_pay.totalCents).toBe(2450 - 1000);
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
      expect(before.spentCents).toBe(3861);

      await api.linkFinanceRefund('fx-refund-3', 'fx-safeway');
      const after = await api.getFinanceOverview({ today: finToday() });
      expect(after.spentCents).toBe(0);
      expect(after.unsortedCount).toBe(before.unsortedCount); // a deposit was never in the queue

      await api.linkFinanceRefund('fx-refund-3', null);
      expect((await api.getFinanceOverview({ today: finToday() })).spentCents).toBe(3861);

      await api.linkFinanceRefund('fx-refund-1', 'fx-safeway'); // a card credit → a debit charge
      await expect(api.linkFinanceRefund('fx-xfer-sav', 'fx-safeway')).rejects.toThrow(); // transfer in
      await expect(api.linkFinanceRefund('fx-refund-3', 'fx-venmo')).rejects.toThrow(); // transfer out
      await expect(api.linkFinanceRefund('fx-ccpay-card-10', 'fx-card-8')).rejects.toThrow(); // marked
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
  });
}
