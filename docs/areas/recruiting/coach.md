# The LeetCode coach

A daily plan for LeetCode practice, derived from the user's own sittings ([index.md](index.md) → _Sittings_): which
problems today, why each, what is due to come back, and how to coach each one. Its main surface is a Claude
conversation over MCP; the app's card is a glance (a later PR). The thread holds no state of its own, so a new
conversation picks up where the last one stopped.

The engine is pure folds in `packages/shared/src/coach.ts`, run by the stub and the Lambda alike. Only the user's
decisions are stored; everything else is recomputed on every read.

## What's stored, what's derived

| Stored (`lcc#`)                            | What                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `lcc#day#<day>` (`CoachDay`)               | that day's floor choice and slot changes (a swap or skip per slot, the newest) |
| `lcc#att#<ulid>` (`CoachAttempt`)          | an attempt made outside the extension, or a peek seeded from the thread        |
| `lcc#focus` (`CoachFocus`)                 | the focus override and the day it started                                      |
| the review's `cause`, `test` (on the head) | the one cause tag of a sitting, and the test-sitting flag                      |

`lcc#mock#` and `lcc#imp#` are reserved for later rows. Derived on read: attempts, problem records, the re-solve
schedule, the focus pattern, the day's plan. At a few dozen sittings a month a read is two small Queries plus the
day rows; no stored count can drift.

- **Peeked is `review.help === 'solution'`**, no field of its own. A manual peek is an attempt with help
  `solution`.
- **A test sitting** never counts: under 3 minutes with no accepted submit, or `review.test`.
- **Cause tags:** `no-trace`, `api-slip`, `boundary`, `off-by-one`, `quit-early`. `tags[]` stay the user's own
  pattern words and `mistakes[]` free text; neither aggregates, the cause does.
- **The review merge.** `setSittingReview` keeps a stored help, cause or test flag it isn't sent, and an explicit
  value replaces it (a null cause clears it; `mergeReview`), so the app form's Save never wipes a peek or a cause set
  over MCP. `patchSittingReview` is the
  coach's partial write.

## Attempts and outcomes

One attempt = one problem on one user day: that day's sittings and manual attempts on it fold into one, judged
as one first try — clean only when the earliest piece with a submit was a first-submit accept and no help was
taken all day; accepted anywhere → solved; else failed. The most help taken wins (a peek sticks). An open sitting is
not an attempt yet, except one from before today (left open overnight), which counts on its own day. A peek counts
even on a sitting under 3 minutes.

| Outcome  | Means                                     |
| -------- | ----------------------------------------- |
| `clean`  | first submit accepted, no help            |
| `solved` | accepted, but not first submit, or a hint |
| `failed` | never accepted, or the solution read      |

## The re-solve scheduler

`resolveState`, gaps as a parameter (`COACH_PARAMS`): clean `[3, 7, 14]`, peeked `[1, 3, 7, 14]`, the last step
due within a further 7 days.

| From      | Event                     | To                                             |
| --------- | ------------------------- | ---------------------------------------------- |
| none      | first `clean` or `solved` | clean track, step 0, due +3                    |
| none      | first `failed`            | peeked track, step 0, due +1                   |
| any step  | re-solve `clean`          | step + 1; past the last → `graduated`          |
| any step  | re-solve `solved`         | same step, due = that day + the same gap       |
| any step  | re-solve `failed`         | peeked track, step 0, due +1                   |
| graduated | `clean` or `solved`       | dormant (countdown mode will re-arm it)        |
| graduated | `failed`                  | peeked track, step 0, due +1 (it didn't stick) |

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
3. **re-solve** — the oldest due, other patterns first (the interleave), the peeked track first on a tie.
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

## The catalog

`packages/shared/src/neetcode150.ts`: the public NeetCode 150 list (slug, LeetCode title, roadmap pattern,
difficulty), kept by hand and pinned by `neetcode150.test.ts`. The 7 LeetCode Premium problems are marked and never
picked. A problem outside the list joins the working catalog from the user's own sittings, its pattern from its
LeetCode tags (`patternOfTags`), else `other`. The user's own problem history never goes in the tracked file.

## Over MCP

`lambdas/src/mcp/coachTools.ts` ([mcp](../mcp/index.md) → _Tools_):

| Tool                                         | Kind   | Over                                                                                                                                            |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `leetcode_today {day?}`                      | read   | `getCoachToday`, plus the per-kind coaching `rules` and the wording note                                                                        |
| `live_sitting`                               | (read) | gains `slot` (kind or `off-plan`, reason, cap, `overCap`, the rules) and `trace` (`summary.coach.trace`, [index.md](index.md) → _Coach events_) |
| `mark_peeked {slug \| sittingId, day?}`      | write  | that day's sitting's review → help `solution`; none → a peek attempt                                                                            |
| `set_cause_tag {sittingId?, cause, peeked?}` | write  | `patchSittingReview`; no id → the newest ended sitting                                                                                          |
| `swap_slot {slug, action, toSlug?}`          | write  | `setCoachSlot`; a swap with no target → the next easier unseen problem                                                                          |
| `log_attempt {attempts[]}`                   | write  | `logCoachAttempts` (≤ 50; no Roll rep, no calibration)                                                                                          |

Every write's description opens with the same ask-first sentence and says what it returns to read back. Leave all
six (these four and the two below) on **Ask** in the connector. The coaching itself (the hint ladder, one push-back before a solution, the
review's one cause) lives in the claude.ai project's instructions, kept outside the repo.

## RPCs

`getCoachToday(day?)`, `listProblemRecords()`, `setCoachSlot({slug, action, toSlug?})`, `setCoachFloor(on)`,
`setCoachFocus(pattern | null)`, `logCoachAttempts(inputs)`, `deleteCoachAttempt(id)`, `patchSittingReview(id,
{cause?, help?, test?})` — JWT only, none an ingest method. Day-scoped writes act on the user's day as the server
reads it. `ExportBundle` carries `coachDays`, `coachAttempts`, `coachFocus`.

## Not yet

Mocks, the
history import, and countdown mode — each its own PR. `CoachToday.mode`, `target` and `arm` are already in the
shape, and the gaps and cap are parameters, so countdown mode and an A/B arm add rather than change.

## Files

| File                                                                                  | What                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/shared/src/coach.ts`                                                        | the engine: attempts, records, `resolveState`, `focusOn`, `planDay`, the write normalizers |
| `packages/shared/src/neetcode150.ts`                                                  | the catalog and the pattern ids                                                            |
| `packages/shared/src/sittings.ts`                                                     | `CAUSE_TAGS`, `mergeReview`, `patchReview`                                                 |
| `packages/shared/src/contractTests.ts`                                                | `lc coach` — run 3× (stub, backend direct, via handleRpc)                                  |
| `lambdas/src/backend.ts`, `app/src/data/stubClient.ts`                                | the coach RPCs                                                                             |
| `lambdas/src/ddb/keys.ts`, `repo.ts`                                                  | the `lcc#` rows                                                                            |
| `lambdas/src/mcp/coachTools.ts`                                                       | the coach's MCP tools and `live_sitting`'s slot                                            |
| `scripts/src/devcheck/scenarios/lc-coach.ts`                                          | the dev check's rows                                                                       |
| `app/src/pages/Recruiting/TodayCard.tsx`, `ReviewForm.tsx`, `Home/LeetcodeGlance.tsx` | the app: the Today card, the cause chips and Peeked, the morning line                      |

## In the app

The thread in claude.ai drives the coaching; the app is the glance and the record.

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
first try is a problem's first attempt ever, so a range never turns a re-solve into one; every later day on it is
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
(`getCoachToday().focus`, the Today card's query); every other ranked pattern has **Set as focus**
(`setCoachFocus`), and an override shows **Back to the coach's pick** (`setCoachFocus(null)`). Either write hands
keyboard focus to the Focus card. A refused write says why inline; a failed read is a `LoadError` with Retry.

Per pattern, over counted attempts only (test sittings never count), from `coachStats` plus `patternDetail`; the
same fields ride `coach_stats` (rates with `pct`):

| Field             | Counts                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `firstTry`        | the problem's first attempt ever, clean                                                                                                       |
| `resolve`         | any later-day attempt, clean (derived from history, so no slot stamp)                                                                         |
| `submitsPerTry`   | captured submits ÷ attempts with one (a re-solve is its own try), to 1 decimal; logged attempts carry none                                    |
| `runBeforeSubmit` | attempts with a captured submit whose first submit had a Run before it                                                                        |
| `traced`          | attempts whose trace stood at all three inputs at the first submit; `partial`, `skipped`, `none` miss; no coach data or the card off: neither |
| `causes`          | cause tags                                                                                                                                    |
| `weeks`           | first tries per ISO week                                                                                                                      |

Rates read "3 of 8"; a percentage joins from 5 tries, so a week of data stays honest. The weekly bars draw a week
under 5 tries hollow. Charts are inline SVG, no dependency. Hooks: `app/src/data/hooks/useCoachStats.ts`, under
the `coach` query prefix, which a task write and a review save invalidate.
