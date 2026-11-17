# The LeetCode coach

A daily plan for LeetCode practice, derived from the user's own sittings ([index.md](index.md) → _Sittings_): which
problems today, why each, what is due to come back, and how to coach each one. Its main surface is a Claude
conversation over MCP; the app's card is a glance (a later PR). The thread holds no state of its own, so a new
conversation picks up where the last one stopped.

The engine is pure folds in `packages/shared/src/coach.ts`, run by the stub and the Lambda alike. Only the user's
decisions are stored; everything else is recomputed on every read.

## What's stored, what's derived

| Stored (`lcc#`)                            | What                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `lcc#day#<day>` (`CoachDay`)               | that day's floor choice, slot changes (a swap or skip per slot, the newest), and its AI pick (`ai`, _The AI pick_) |
| `lcc#att#<ulid>` (`CoachAttempt`)          | an attempt made outside the extension, a peek seeded from the thread, or a history-only solve (`historical`)       |
| `lcc#focus` (`CoachFocus`)                 | the focus override and the day it started (`source`: the user's, or `ai`)                                          |
| the review's `cause`, `test` (on the head) | the one cause tag of a sitting, and the test-sitting flag (a void sitting)                                         |
| `lcc#void#<day>#<slug>` (`CoachVoid`)      | a legacy day's void state, `void: true` or `false` (_Legacy history_)                                              |
| the head's `claudeNotes`                   | Claude's own notes on an ended sitting (_Claude's notes_), never in the review                                     |

`lcc#mock#` and `lcc#imp#` are reserved for later rows. Derived on read: attempts, problem records, the re-solve
schedule, the focus pattern, the day's plan. At a few dozen sittings a month a read is two small Queries plus the
day rows; no stored count can drift.

- **Peeked is `review.help === 'solution'`**, no field of its own. A manual peek is an attempt with help
  `solution`.
- **A test sitting** never counts: under 3 minutes with no accepted submit, or `review.test` — a **void** sitting.
  Voiding (`set_void`, or **Doesn’t count** on the sitting's page) sets the flag and deletes nothing; un-voiding
  (`void: false`, **Count it again**) clears it, and an otherwise empty review goes back to null. A review that only
  voids is no review: the list's reviewed mark and `list_sittings.reviewed` read `hasReviewWords`. The flag lives in the
  review, apart from H's `closedBy`, so an idle-closed sitting voids like any other.
- **Legacy rows** (`lc#`, the pre-sittings capture) are read, never written: _Legacy history_.
- **Cause tags:** `no-trace`, `api-slip`, `boundary`, `off-by-one`, `quit-early`. `tags[]` stay the user's own
  pattern words and `mistakes[]` free text; neither aggregates, the cause does.
- **The review merge.** `setSittingReview` keeps a stored help, cause or test flag it isn't sent, and an explicit
  value replaces it (a null cause clears it; `mergeReview`), so the app form's Save never wipes a peek or a cause set
  over MCP. `patchSittingReview` is the
  coach's partial write.
- **History-only solves** (`CoachAttempt.historical`, logged with `log_attempt`'s `historical: true`, dated before
  today — yesterday when no day is given — and up to 10 years back): a solve from before the coach. It never reaches `attemptsOf`; `historyAttemptsOf` folds them by day the same
  way. A problem with one is _seen_ (never a new or stretch pick, never "unseen" for the focus ranking or the room
  check; swapped in, it's a re-solve) and gets a record (`ProblemRecord.historical`, its tries flagged), but no
  schedule, and a live try dated after it is no first try (a re-solve in the stats and the focus ranking; a live
  try before it stays a first try), and no part of momentum, active days
  or the stats counts. A day's live tries win over it: its base fields come from the live tries whenever there are
  any. `CoachScope` carries the history and the Premium setting into the folds that need them; absent, the engine
  is as it was. A live attempt stays at 60 days back.

## Attempts and outcomes

One attempt = one problem on one user day: that day's sittings and manual attempts on it fold into one, judged
as one first try — clean only when the earliest piece with a submit was a first-submit accept and no help was
taken all day; accepted anywhere → solved; else failed. The most help taken wins (a peek sticks). An open sitting is
not an attempt yet, except one from before today (left open overnight), which counts on its own day. A peek counts
even on a sitting under 3 minutes. A legacy day folds in as one more piece (_Legacy history_); a logged peek that
was also accepted (`accepted: true`) stays `failed` but counts toward `everAccepted`.

| Outcome  | Means                                     |
| -------- | ----------------------------------------- |
| `clean`  | first submit accepted, no help            |
| `solved` | accepted, but not first submit, or a hint |
| `failed` | never accepted, or the solution read      |

## Legacy history

The extension before sittings wrote one row per submission under `lc#<day>#<id>` (`LegacyLeetcodeAttempt`) until PR
147 (2026-11-10); nothing deletes them and no TTL reaches them. The coach reads them (`repo.listLegacyLeetcode`, every
coach read and the AI pick's), never writes them — no put exists, and `backend.coachFixes.test.ts` pins that every coach
write leaves them as they were. No migration: one copy, and removing the reader undoes it.

- **The fold** (`legacyAttempts`): each (day, slug) group is one piece, judged like a sitting's submits — the earliest
  row's verdict is the first submit, any accept is accepted, the row count is the submits; no runs, no trace, help
  `none` (the capture couldn't see a peek). Title and difficulty come from the catalog, else the row; the pattern
  from the catalog, else `patternOfTags`. `sources: ['legacy']` marks it in `get_problem`'s tries.
- **With a logged attempt the same day** it folds into one attempt (`foldDay`), so the claude.ai backfill never
  counts a day twice. The capture's submit time precedes a later log, so it judges the first try (measured beats
  remembered: a logged `clean` over a failed first submit folds to `solved`); a logged peek still wins on help; the
  captured title wins over a logged one.
- **Voids.** A group counts unless voided: a stored `CoachVoid` row for that (day, slug) wins; else the default list
  `LEGACY_TEST_DEFAULTS` (`two-sum`: the extension was tested on it) excludes it; else it counts. `void: false` lifts a
  default; `void: true` drops any group. Only legacy pieces take a void row or the default — a sitting voids through its
  review, a logged attempt is deleted (`delete_attempt`). `setCoachVoids` refuses, writing nothing, a day with no
  legacy rows. `listLegacyGroups(slug?)` lists every group with `counted` and `voidedBy` (`you` / `default`).
- On deploy the legacy days join the history: new records, new due re-solves, and possibly Auto in Catch-up on day
  one. `set_void` is the lever.

## The re-solve scheduler

`resolveState`, gaps as a parameter (`COACH_PARAMS`): clean `[3, 7, 14]`, retry `[1, 3, 7, 14]`, the last step
due within a further 7 days. The `retry` track is where a failed attempt lands — never accepted, or the solution
read; it was called `peeked` until coach-fixes, which read like the peeked flag (`record.peeked`: the solution was
read). Nothing stored the track, so nothing migrated; `list_problems`' `track` filter still takes `peeked` as retry.

| From      | Event                     | To                                            |
| --------- | ------------------------- | --------------------------------------------- |
| none      | first `clean` or `solved` | clean track, step 0, due +3                   |
| none      | first `failed`            | retry track, step 0, due +1                   |
| any step  | re-solve `clean`          | step + 1; past the last → `graduated`         |
| any step  | re-solve `solved`         | same step, due = that day + the same gap      |
| any step  | re-solve `failed`         | retry track, step 0, due +1                   |
| graduated | `clean` or `solved`       | dormant (countdown mode will re-arm it)       |
| graduated | `failed`                  | retry track, step 0, due +1 (it didn't stick) |

Only a first-try accept advances: first-try accuracy is the gap being trained. A due item is "due" from its day on
— never "overdue", never a count.

## The focus pattern

Per pattern, a shrunk first-try miss rate `(misses + 1) / (first tries + 2)`, ties by the roadmap order; a
pattern with no unseen catalog problem drops out. A pattern holds 3 active days. From the anchor (the override's
day, else the first counted attempt) each block of 3 active days takes the top-ranked pattern as of its first
day, never the previous block's. Block 0 is the override, else the top-ranked as of the anchor. An override on a
pattern with nothing unseen left is refused; the same pattern again keeps its day while it holds, and re-stamps
from today once the engine has moved on. The replay is
deterministic, so a read writes nothing; `focus.why` says why.

## The day's plan

`planDay`, from everything before the user's day (their zone, `dayStartHour`), so it holds still all day:

1. **carry-over** — the last active day's newest unaccepted, unpeeked problem, if within 2 days (one; any other
   stays a due re-solve); it leaves the re-solve
   and due lists for the day.
2. **new** — the focus pattern's first unseen catalog problem; one swapped out in the last 3 days goes to the back.
3. **re-solve** — the oldest due, other patterns first (the interleave), the retry track first on a tie.
4. **stretch** — an unseen focus-pattern problem one difficulty up from the new pick, else an unseen Medium from
   the next-ranked pattern.

One of each; an empty kind lets the next kind take a second (stretch wraps to new). At most 2 a kind, 4 in all,
never padded. **Floor:** the oldest due re-solve, else the carry-over, else the new pick (`floor.kind` says which). Then the day's changes
apply, and today's sittings and attempts mark each slot `in-progress` or `done`. **A sitting is linked to its slot
by slug on read**, never stamped, so a swap after a Start still reads right; a sitting on any other problem is
`offPlan` and leaves the queue alone. A swap never takes another slot's problem or engine pick, and "Another"
never offers back the pick it replaced. A swapped-in problem takes its own kind (the carry-over; a due or
already-tried problem is a re-solve; an unseen one is new, or a stretch in a stretch slot), so its coaching rules
are right; a change is matched by the engine's pick alone. "Easier" is strictly easier, the nearest level first,
falling back to the same level only when the pattern has nothing easier left. Reasons say days as a person would
("yesterday", "November 14"), and a re-solve's opens with today's rule. A slot is a rep only once the extension's Start runs (one open rep per roll,
[rolls](../home/rolls.md) D6).

### Plan mode

The slot mix is a setting (`Settings.coachPlanMode`, Settings → LeetCode → Plan mode; rows from before read `auto`):

| Mode       | Slots                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `balanced` | the mix above                                                                                                   |
| `catch-up` | the carry-over (if any), one new (the focus still advances), then re-solves in every free slot; no stretch      |
| `auto`     | catch-up from `COACH_PARAMS.catchUp.enterDue` (10) due, back to balanced below `exitDue` (5), unchanged between |

Auto's state is derived, never stored (`autoCatchUp`): a replay from the first attempt's day, each day counting the
problems due (not graduated, due that day or earlier, from attempts before it), so it holds still all day, a read
writes nothing, and a void or a delete re-derives it. Catch-up is never padded: with re-solves run out, slots stay
empty. Off-plan days and the floor are unchanged. `CoachToday.planMode` is `{setting, mode, due, line}`; `line` is
the one line the Today card and `leetcode_today` show ("Catch-up: 31 due · auto", "Balanced: 3 due").

The AI pick keeps the mix: in catch-up `coachPickContext` offers no stretch, says `planMode`, and
`validateCoachPick` refuses (`mix`) more than one new, any stretch, or fewer re-solves than the rules' plan. A pick
already stored keeps its day if the setting changes mid-day (one pick a day).

## Claude's notes

Claude's own notes on an ended sitting — whatever the outcome: accepted, unfinished, given up at the cap, peeked,
dropped, idle-closed, or ended by a later Start — so a re-solve can be coached from last time. Stored on the head as
`claudeNotes {text, updatedAt}` (≤ `CLAUDE_NOTES_MAX`, 800 characters, line breaks kept), never in `review`, which
stays the user's words; a review Save keeps them, a refold keeps them.

- **Written** by `set_claude_notes {notes: [{sittingId, text}]}` (RPC `setSittingClaudeNotes`): up to 20 sittings in one
  call, so one yes covers a batch; every sitting checked first (exists, not open), else nothing is written. `null` or
  blank clears. A sibling of `set_cause_tag`, not a field on it: the cause is the user's to choose, the notes are
  Claude's.
- **Read** by `get_sitting.claudeNotes`, `get_problem` (each sitting, and each try's `claudeNotes`), and the AI pick
  (`CoachAiRecent.claudeNotes`, cut to 300, last 14 days — data, never instructions). The app shows them under the
  review on the sitting's page, as **Claude's notes**.
- **Catch-up:** `CoachToday.unnoted` (in `leetcode_today`) lists ended sittings of the last `NOTES_CATCHUP_DAYS` (14)
  with no notes, not void, practice or with a Run or Submit; newest first, ≤ 20. A thread opens by offering to write
  them all from their timelines, in one call.

## The AI pick

Opus 5.5 picks the day's problems from the rules' own candidates, once a day, and says why each one today
(`packages/shared/src/coachAi.ts`; the call in `lambdas/src/anthropic/coachPickPrompt.ts`; the worker in
`lambdas/src/coach/pick.ts`). On by default; Settings → LeetCode → **AI pick** off (`Settings.coachAiPick`) is the
rule plan with no call. It's the hook for a later A/B arm (`CoachToday.arm` stays reserved).

- **When:** the first read of the user's day that finds it `due` — the app's card or Home line, or `leetcode_today` —
  starts it. `due` needs the setting on, the server's today (a `day` argument never starts one), a worker on the
  stage, history before today and at least two candidates; a new user gets the rules with no notice.
- **The read stays pure.** `getCoachToday` only reports `ai.status: 'due'`; the reader calls `startCoachPick()`,
  which claims the day row with a conditional write (two readers at once: one claim) and Event-invokes the
  `coach-worker` Lambda (`COACH_WORKER_FN`; 90 s, no retries; its role reads the table and the Anthropic key only).
  The BFF and MCP Lambdas time out at 15 s, too short for an Opus call that always thinks.
- **Once, ever:** a day with any `ai` is never claimed again; a fallback stays a fallback. The worker starts only its
  own claim, once (`startedAt` fences a redelivered event), gives up without a call when its event waited over 20 s,
  and its writes land only on that claim. A claim older than 120 s reads as `fallback`/`timeout` with no write, so a
  dropped event never leaves a reader waiting; a result after that is stored as the timeout readers saw. A day
  already under way on the rules (a slot changed, or practice logged today) isn't picked: a pick landing then would
  replace a plan in use.
- **The worker** (`lambdas/src/coachWorker.ts` → `runCoachPick` in `coach/pick.ts`; the infra is INFRA §1): its event
  is `{userId, day, claimId}` (anything else refused before any read). It starts the claim (a conditional put of
  `startedAt`), reads the day's input strongly consistent, builds the context, makes the call, runs the answer through
  the guardrails, settles the row, then applies a focus change. An event for a claim that isn't its own, already
  started or settled, or for a day with no row, returns `not-ours` with no call; a throw after the start settles
  `unavailable`/`error` at once. The switch off by then settles `unavailable`/`off` with no call (the
  day stays a fallback if it's turned back on). One log line a run (`coach_worker`: the run, day and claim, never the user id), plus
  `coach_pick` from the gateway and `coach_pick_rejected` with a guardrail's code. Callers reach it through a
  `CoachPickInvoker` (`coach/invoker.ts`): live (an Event invoke), inline (tests, the local check), or disabled
  (testMode, or no `COACH_WORKER_FN` on the stage — then no pick is ever `due`).
- **Candidates** (`coachPickContext`): the rules' own pick first (with its kinds), then the carry-over, ≤ 15 due
  re-solves oldest first, ≤ 5 unseen in the focus, ≤ 3 stretch, and, while no focus pick is held, ≤ 3 unseen in each
  other top-3 pattern behind a focus change (`ifFocus`). Context: the rules' order, the last 14 days of attempts
  (outcome, help, cause, last error, minutes against the 30-minute cap, notes cut to 160), per-pattern rates,
  momentum, the focus, the top 3. No ids. The user's practice data goes to the API, as for the review draft.
- **The call:** `claude-opus-5-5`, thinking on (it can't be off), effort `medium`, structured output (slugs and
  patterns enumerated), 60 s, 8,000 max tokens, no fallback model, no retry; one log line `coach_pick` with tokens,
  never text. Typical ≈ 4–7k in, 1–3k out: about $0.04–0.10 a day, worst ≈ $0.18.
- **Guardrails, in code, never trusted to the model** (`validateCoachPick`): 1–4 unique picks, every one a
  candidate, a short answer filled to four from the rules' pick (`fillToFull`: the model's picks first, in its order;
  fewer only when fewer candidates are allowed); the oldest due re-solve can't be skipped two AI days running (`mustInclude`, from the last `ok` day's
  `oldestDue`); a focus change only to another top-3 pattern and never while a pick (the user's or the AI's) is held; an
  `ifFocus` pick only with that change. Any break rejects the whole answer (`invalid`, the code in `detail`); only
  text is repaired (trimmed, a why ≤ 140, the note ≤ 240, an empty why → the rule's reason). The floor is always
  the rules'.
- **Any failure** — no key, a timeout, an API error, a refusal, bad JSON, a guardrail, a failed invoke — is the rule
  plan with the notice "AI pick unavailable today, using the rules" on the card and in the thread. Never silent.
- **The view:** an `ok` pick replaces the rule slots in its order (`CoachSlot.aiWhy`; `reason` keeps the rules'
  facts); swaps, skips, status and alternatives work as on any day, keyed by the pick; it isn't re-checked on later
  reads, so it holds all day. A focus change writes `CoachFocus` with `source: 'ai'` after the day row, and shows
  only while that focus holds. While `due` or `pending` the card and the thread show no slots ("Opus is picking
  today's problems…"; the card polls every 2.5 s, `leetcode_today` waits ≤ 7.5 s); a slot change is refused while
  `pending`. A focus change never overwrites one the user made during the call. A start that failed shows the
  rules with a Retry, on the card and the Home line, for the rest of the day (the start's state is shared by every
  reader, `useCoach.ts`).
- **Local and stub:** both run the worker's steps with `standInCoachPick` — the rules' own pick and reasons, no
  note — through the real guardrails; the stub's `aperture:stub:coachPick` key (`fallback`, `invalid`, `slow`)
  shows the other states.

## The catalog

`packages/shared/src/neetcode150.ts`: the public NeetCode 150 list (slug, LeetCode title, roadmap pattern,
difficulty), kept by hand and pinned by `neetcode150.test.ts`. `catalogs.ts` labels each list by its source
(`CATALOGS`, `CatalogId`; NeetCode 150 alone today) and answers `catalogProblem` and `listsOf` across all of them; a
problem on two lists has the same facts in each (`catalogs.test.ts`). The plan picks from `DEFAULT_CATALOG`; a
second list adds a member there, and its picker a Settings field, since the plan, MCP and every device must agree.

The 7 LeetCode Premium problems are marked `premium`. **`Settings.leetcodePremium`** (default on; an older row reads
as on) lets the coach pick them like any other — `pickable`, `easierIn`, the ranking's "nothing unseen left" and
the room check all honour it (`CoachInput.premium`); off, they're never picked. The focus replay reads the setting
as it stands now, so flipping it can move the focus (a pattern whose only unseen problems are Premium drops in or
out of the ranking), and today's new or stretch pick with it. A problem outside the list joins
the working catalog from the user's own sittings, its pattern from its LeetCode tags (`patternOfTags`), else
`other`. The user's own problem history never goes in the tracked file.

## Over MCP

`lambdas/src/mcp/coachTools.ts` ([mcp](../mcp/index.md) → _Tools_):

| Tool                                                                    | Kind   | Over                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leetcode_today {day?}`                                                 | read   | `getCoachToday`, plus the per-kind coaching `rules` and the wording note; starts a `due` AI pick and waits ≤ 7.5 s; `ai` and each slot's `why`                                                                    |
| `live_sitting`                                                          | (read) | gains `slot` (kind or `off-plan`, reason, cap, `overCap`, the rules), `trace` and `traceBy` (`summary.coach`, [index.md](index.md) → _Coach events_)                                                              |
| `mark_peeked {slug \| sittingId, day?, accepted?, title?, difficulty?}` | write  | that day's sitting's review → help `solution`; none → a peek attempt (an accept that day kept; a title and difficulty off the roadmap)                                                                            |
| `set_cause_tag {sittingId?, cause, peeked?}`                            | write  | `patchSittingReview`; no id → the newest ended sitting                                                                                                                                                            |
| `swap_slot {slug, action, toSlug?}`                                     | write  | `setCoachSlot`; a swap with no target → the next easier unseen problem                                                                                                                                            |
| `log_attempt {attempts[]}`                                              | write  | `logCoachAttempts` (≤ 50; no Roll rep, no calibration); an item's `historical: true` is a history-only solve, up to 10 years back; help `solution` is a peek in one call (outcome optional; `accepted`), `title` + `difficulty` off the roadmap; a repeated peek fills what the first lacked |
| `set_void {targets[]}`                                                  | write  | a sitting's `review.test` (`patchSittingReview`) or a legacy day's `CoachVoid` (`setCoachVoids`); ≤ 50, every target checked first                                                                                |
| `set_claude_notes {notes[]}`                                            | write  | `setSittingClaudeNotes` (≤ 20, ≤ 800 characters each, ended sittings, all or nothing)                                                                                                                             |

Every write's description opens with the same ask-first sentence and says what it returns to read back. Leave all
eight (these six and the two below) on **Ask** in the connector. The coaching itself (the hint ladder, one push-back before a solution, the
review's one cause) lives in the claude.ai project's instructions, kept outside the repo.

## RPCs

`getCoachToday(day?)`, `startCoachPick()`, `listProblemRecords()`, `setCoachSlot({slug, action, toSlug?})`, `setCoachFloor(on)`,
`setCoachFocus(pattern | null)`, `logCoachAttempts(inputs)`, `deleteCoachAttempt(id)`, `patchSittingReview(id,
{cause?, help?, test?})`, `listLegacyGroups(slug?)`, `setCoachVoids(inputs)`, `setSittingClaudeNotes(items)` — JWT
only, none an ingest method. Day-scoped writes act on the user's day as the server reads it. `ExportBundle` carries
`coachDays`, `coachAttempts`, `coachFocus`, `coachVoids`, and the legacy rows (`legacyLeetcodeAttempts`, read-only).

## Not yet

Mocks, a bulk import of LeetCode's own submission history, a second problem list with its picker, and countdown
mode — each its own PR. (History-only solves cover logging old solves by hand, in the thread.) `CoachToday.mode`,
`target` and `arm` are already in the shape, and the gaps and cap are parameters, so countdown mode and an A/B arm
(the AI pick against the rules) add rather than change.

## Files

| File                                                                                  | What                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/shared/src/coach.ts`                                                        | the engine: attempts, records, `resolveState`, `focusOn`, `planDay`, the write normalizers |
| `packages/shared/src/coachAi.ts`                                                      | the AI pick: candidates, context, guardrails, the stand-in, the day row's claim steps      |
| `lambdas/src/anthropic/coachPickPrompt.ts`, `lambdas/src/coach/`, `coachWorker.ts`    | the AI pick's prompt, the worker and its invokers                                          |
| `packages/shared/src/neetcode150.ts`, `catalogs.ts`                                   | the NeetCode 150 list and the pattern ids; the lists by source                             |
| `packages/shared/src/coachProgress.ts`                                                | the Progress tab's folds: `problemStatus`, `coverage`, `PROGRESS_STAGES`, the trends       |
| `packages/shared/src/sittings.ts`                                                     | `CAUSE_TAGS`, `mergeReview`, `patchReview`                                                 |
| `packages/shared/src/sittings.ts`                                                     | `CAUSE_TAGS`, `mergeReview`, `patchReview`, `hasReviewWords`, the trace fold               |
| `packages/shared/src/traceComment.ts`                                                 | the trace-comment rule ([index.md](index.md) → _Coach events_)                             |
| `packages/shared/src/coachLegacyFixtures.ts`                                          | synthetic legacy rows for tests                                                            |
| `packages/shared/src/contractTests.ts`                                                | `lc coach`, `lc coach ai` — run 3× (stub, backend direct, via handleRpc)                   |
| `lambdas/src/backend.ts`, `app/src/data/stubClient.ts`                                | the coach RPCs                                                                             |
| `lambdas/src/ddb/keys.ts`, `repo.ts`                                                  | the `lcc#` rows, and the legacy `lc#` reader                                               |
| `lambdas/src/mcp/coachTools.ts`                                                       | the coach's MCP tools and `live_sitting`'s slot                                            |
| `scripts/src/devcheck/scenarios/lc-coach.ts`, `lc-coach-ai.ts`, `coach-fixes.ts`      | the dev check's rows                                                                       |
| `app/src/pages/Recruiting/TodayCard.tsx`, `ReviewForm.tsx`, `Home/LeetcodeGlance.tsx` | the app: the Today card, the cause chips and Peeked, the morning line                      |
| `app/src/pages/Recruiting/Progress*.tsx`, `SolvesList.tsx`, `ProblemPage.tsx`         | the Progress tab and a problem's page (helpers in `progressHelpers.ts`)                    |
| `app/src/pages/Recruiting/SittingDetail.tsx`, `app/src/pages/Settings/index.tsx`      | void (**Doesn’t count**), **Claude's notes**, Settings → Plan mode                         |

## In the app

The thread in claude.ai drives the coaching; the app is the glance and the record.

- **Plan mode and void (coach-fixes).** The Today card shows `planMode.line` under the focus line and marks a retry-track
  queue row "· retry". Settings → LeetCode → **Plan mode** is three radios (Auto, Balanced, Catch-up). A sitting's
  page has **Doesn’t count** (a quiet button; one button whose label flips to **Count it again**, so focus stays put;
  a boxed notice while void; a refusal inline) and, under the review, **Claude's notes** when written. The sittings
  list marks a void row "Doesn’t count".

- **The Today card** sits above the sittings on `/recruiting` (`TodayCard.tsx`, `useCoach.ts`). It shows the
  focus line with **Change** (a pattern, or the coach's pick, which clears the override), up to four slots, the
  floor, the due re-solves not already a live slot (a skipped or swapped-away one stays listed) plus the next 48
  hours (`dueBeyondSlots`), off-plan sittings, ended sittings with no
  cause yet, and the week's momentum. Each slot is its kind, difficulty, the cap, the reason and a LeetCode link in
  a new tab. An in-progress slot links to its sitting, and a done one to its review. **Another** (only while
  `alternatives` has an easier unseen problem), **Skip today** and **Restore** are `setCoachSlot`; **Floor day**
  and **Full day** are `setCoachFloor`. One write at a time, so a double tap is one call; focus stays in the slot's row as its buttons change
  (CONVENTIONS → focus-return). A refused change says why
  inline, and a failed read is a `LoadError` with Retry. Tones are teal for done-clean and gold or muted
  otherwise, never red.
- **The review form** adds five cause chips (one choice; a second tap clears it) and labels help's `solution` as
  **Peeked**. With no review at all, it starts on a suggested `no-trace` (`suggestedCause`) when the trace was
  skipped or missing at the first submit, or when that submit failed with no Run before it.
- **Claude's writes while the form is open (F169).** Help and the cause are also set over MCP (`mark_peeked`,
  `set_cause_tag`). Until the user touches one, the field follows the stored review as it refreshes, and Save
  doesn't send it: `setSittingReview` keeps an absent help or cause (`mergeReview`). Only a first review's
  suggestions (a hint, No trace) are sent untouched, and only if a re-read just before the Save still finds no
  review, so one Claude wrote since the form opened wins. Help and the chips refuse taps while a Save runs; a
  failed re-read fails the Save, keeping every field.
- **Home's morning line** (`Home/LeetcodeGlance.tsx`, the `FinanceGlance` posture): "LeetCode · 4 today · +1
  re-solve due" (due re-solves beyond the live slots) → `/recruiting`. It is read only while a LeetCode roll is linked. A floor day names its one
  problem. A failed read is one visible line, never silence.
- A review or task write in the app (a rep's Done included) invalidates the `coach` query prefix. The
  extension's writes don't reach the app's cache: the card catches up when it next mounts with data over 30 s old (a later visit).

## The history, stats and story reads, and two more writes

Added beside _Over MCP_'s table, in `coachTools.ts`; all six writes stay on **Ask**:

| Tool                                              | Kind  | Over                                                                                                                       |
| ------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `list_problems {pattern?, due?, peeked?, limit?}` | read  | `listProblemRecords`; `due: true` is the re-solve queue (due today or earlier), oldest first; limit ≤ 100, default 30      |
| `get_problem {slug}`                              | read  | one record, its `tries` (each day's outcome, help, cause, sitting and logged-attempt ids) and its sittings; untried → null |
| `coach_stats {from?, to?}`                        | read  | `getCoachStats`, rates with a `pct` only from 5 tries, `weakest`, and a note on how to read it                             |
| `list_stories`                                    | read  | `listStories`: the STAR story bank, for behavioral mocks                                                                   |
| `set_focus_pattern {pattern \| null}`             | write | `setCoachFocus`, then the focus as the plan reads it; `other` refused                                                      |
| `delete_attempt {id}`                             | write | `deleteCoachAttempt`, after finding the id among the live logged attempts; none → `deleted: false`, nothing written        |

**Stats** (`coachStats`, RPC `getCoachStats(range?)`): over the counted attempts, so test sittings never count. A
first try is a problem's first attempt ever, with no history-only solve dated before it, so a range never turns a re-solve into one; every later day on it is
a re-solve. Clean is the only hit for both — the gap is first-try accuracy. Per ISO week (the trend) and per
pattern, weakest first by the focus ranking as of now (`rank`; null once the pattern has nothing untried). Also
active days, peeks, the cause mix and `untagged` (went wrong, no cause). The pattern dashboard grows `PatternStat`
additively.

### The draft's cause

The review draft's one Haiku call also proposes the cause (`ReviewDraft.cause`, a tag or null): the prompt gives
each tag's meaning and four signals beside the cases — accepted at all, the sitting ended (quit-early needs it), a
Run before the first Submit, the extension's trace state ([index.md](index.md) → _Review and the Claude draft_).
The cause stays out of the mistake lines, and a signal is never a line of its own. No extra call; about 20 more output
tokens, so the ≈ $0.0003 a draft stands. A stray value is null and keeps the lines. The stub stands in with a
fixed rule: a failed first Submit with no Run before it proposes `no-trace`, else nothing.

On the form (`ReviewForm.tsx`) the proposal marks its chip — a dashed outline and "Claude suggests Boundary — tap it
to use it" — and never picks it, as draft lines arrive unticked: a Save keeps the cause as it was (the form's own
`no-trace` suggestion included), and only a tap makes it the cause. A Save or a new draft clears the proposal.

## The Patterns tab

`/recruiting/patterns` (`app/src/pages/Recruiting/PatternsSection.tsx`, helpers in `patternsHelpers.ts`, tests
beside them): all 18 roadmap patterns in the order the focus ranks them (`getCoachStats().ranking`, weakest first
tries first; an untried pattern scores as a coin flip), then any practised to the end of its list ("All seen"),
then `other` — problems outside the roadmap — last and only once something lands there. The day's focus is marked
(`getCoachToday().focus`, the plan's own focus); every other ranked pattern has **Set as focus**
(`setCoachFocus`), and an override shows **Back to the coach's pick** (`setCoachFocus(null)`). Set moves keyboard focus to the new focus row, Back to the Focus card. A failed write says why in the row it came from: a refusal "Nothing changed", a 5xx "may have saved"; a failed read is a `LoadError` with Retry.

Per pattern, over counted attempts only (test sittings never count), from `coachStats` plus `patternDetail`; the
same fields ride `coach_stats` (rates with `pct`):

| Field             | Counts                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `firstTry`        | the problem's first attempt ever (none after a history-only solve), clean                                                                     |
| `resolve`         | any later-day attempt, clean (derived from history, so no slot stamp)                                                                         |
| `submitsPerTry`   | captured submits ÷ attempts with one (a re-solve is its own try), to 1 decimal; logged attempts carry none                                    |
| `runBeforeSubmit` | attempts with a captured submit whose first submit had a Run before it                                                                        |
| `traced`          | attempts whose trace stood at all three inputs at the first submit; `partial`, `skipped`, `none` miss; no coach data or the card off: neither |
| `causes`          | cause tags                                                                                                                                    |
| `weeks`           | first tries per ISO week                                                                                                                      |

Rates read "3 of 8"; a percentage joins from 5 tries, so a week of data stays honest. The weekly bars draw a week
under 5 tries hollow. Charts are inline SVG, no dependency. Hooks: `app/src/data/hooks/useCoachStats.ts`, under
the `coach` query prefix, which a task write and a review save invalidate.

## The Progress tab

`/recruiting/progress` (`ProgressSection.tsx`, `ProgressMap.tsx`, `SolvesList.tsx`, `ProgressTrends.tsx`; helpers in
`progressHelpers.ts`, folds in `coachProgress.ts`, tests beside them): how much of the list is done, what's left,
and every solve. On a wide screen the tab runs wider than the app's column (up to 72rem), since five stage columns
and the tables need the room; the header, tabs and dock stay in the column. Patterns says how well; Progress says how much, and never repeats a per-pattern rate. It reads
`listProblemRecords()` (hook `useCoachProgress.ts`, under the `coach` prefix) and the day's plan for today and the
focus marker; the list is static shared data, so there is no RPC of its own. The view (`?view=map|solves|trends`),
the open pattern (`?open=`), Left only (`?left=1`) and the Solves filters (`?pattern= &status= &difficulty=`) live in
the URL, so a reload or Back keeps them.

- **Status** (`problemStatus`): from the newest live try — clean, solved, peeked (the solution read) or not yet
  (not accepted); a problem with only history-only solves reads _Solved before_ (or not yet, if none was
  accepted); untried otherwise. **Done** is a clean or solved try, live or history-only (a try that read the solution
  never counts), so a failed re-solve shows in its square but never takes a solved problem off the count. Due since / next due / graduated come
  from the schedule. Teal for clean, gold for the rest that went somewhere, muted for history, never red; a due
  re-solve is never "overdue".
- **The map** (`coverage` against `DEFAULT_CATALOG`, `PROGRESS_STAGES`): a summary line (done, tried, not tried,
  off the list, due) over a whole-list bar, then the 18 patterns in our own five stages, in roadmap order:
  Foundations, Linked structures, Search, Dynamic programming, Toolkit. Each stage is a column on a wide screen
  (one under another on a phone) with its meter and a card per pattern; a card's squares are its problems, shape
  and fill carrying each state (hollow, dotted Premium when the setting is off, solid, ringed when due), and its
  accessible name says it all in words. A card opens its problems in a panel — status, tries, last tried, re-solve,
  LeetCode link, each title linking its page — under all five stages on a wide screen, under its own stage on a
  phone; Close returns focus to the card. **Left only** lists what's left: the open pattern's untried problems, or
  every pattern's. Problems off the list show under **Off the list**, never in the 150.
- **Solves**: every touched problem, the newest try first: pattern, difficulty, status, first try, tries, last
  cause, last tried, re-solve. Filters by pattern, status (incl. re-solve due, graduated, solved before) and
  difficulty; no match offers Clear filters.
- **Trends** (`progressWeeks`, `capTimes`), live tries only, the last 12 ISO weeks (all four cards): problems a week (clean / solved
  / not yet), first tries clean and re-solves clean a week (a week under 5 tries hollow), and minutes a try against
  the 30-minute cap (`capMin`) with the median. A try's minutes: a sitting's to its first accept (both on the
  extension's clock), else its length once ended; a logged try's as given. Each card says what it needs when
  there isn't enough yet.
- **A problem's page** (`/recruiting/progress/:slug`, `ProblemPage.tsx`): its lists, status and re-solve, then
  every try newest first — minutes (over the cap in gold), help, cause, the logged note, its sittings — a
  history-only one tagged _Before the coach_ with its outcome. ← Progress returns to the view and filters it came from. A slug on no list and never
  tried says so.
- A failed records read is a `LoadError` with Retry, never an empty map; a failed plan read still draws the map,
  with one line saying no pattern is marked. Settings → LeetCode's **I have LeetCode Premium** re-reads the coach.
