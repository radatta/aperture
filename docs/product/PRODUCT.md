# Aperture — Product Spec

Personal life-OS PWA. Web-first, installable to phone. One codebase, both surfaces.
Status: built — see [`docs/index.md`](../index.md). Started: 2026-08-02.

---

## 1. Identity

**One line:** Aperture is the single aperture my whole digital life passes through — the place I plan, do, capture, and later look back through.

**Who it's for:** me, specifically. A student now, full-time SWE next year, currently interning. Motivated and ambitious, prone to tunnel vision, and aware that emotions can run the show in hard moments. Trying to notice that more and be more mindful *without* sacrificing output — and to find a real work/life balance that comes from wanting it, not from forcing it and resenting it.

**The job it does:** get everything out of my head and into one trusted place, so I'm less stressed, scope my time honestly, and can look back weeks/months later and see patterns I can't see in the moment.

### The core tension it must hold
Stay ambitious and productive **and** get more mindful/balanced — with a hard rule: **balance can't be enforced by guilt.** If the app ever makes "call a friend" or "rest" feel like a chore I'm failing at, it has broken its own premise. Non-work life is invited, never policed.

### Why the past versions failed (design against these)
1. **Inconsistency, not features.** The functionality existed; I fell back into keeping the task list in my head and stopped doing morning/night journaling. → **The #1 job of v1 is to earn a daily ritual without relying on willpower.** No guilt-streaks (I'd rebel or feel bad); the pull has to be that the home is genuinely worth opening.
2. **Bland UI.** Pre-AI, all effort went to function, it looked like shit, nothing invited me back. → Smooth, quiet, considered UI is a v1 requirement, not polish-later.

### Two things my own words define
1. **The bar to beat is my own memory.** Keeping tasks in my head "works" for completion — so Aperture's value prop is *not* "get more done." It's **less stress + honest scoping.** That reframes success: the win is a calmer head and realistic plans, not a higher task count.
2. **I chronically under-scope and don't buffer (self-aware overconfident).** → Tasks should capture **estimate vs actual time**, and the app should quietly show me my own estimation bias over time. This is the decision-journal / calibration idea aimed at my single biggest weakness — and it's the most *me* version of "mindfulness": data about my own overconfidence, not a mood emoji.

### Derived design principles
- **Earn the open.** Every surface answers "why am I glad I opened this," or it's cut.
- **Frictionless capture beats rich capture.** Getting a thought in must cost near-zero, or I'll keep it in my head.
- **Invite, don't police** non-work life. Balance is surfaced gently, never scored or streak-shamed.
- **Reflect me back to myself** — estimation bias, past entries, patterns — as *evidence*, not judgment.
- **Quiet, field-notebook aesthetic.** Closer to a terminal or a good notebook than a pastel app.

### v1 usage model
- **Anchors: morning + night** (guaranteed touchpoints). The home should have a distinct **morning mode** (plan/intent) and **night mode** (log/reflect).
- **Daytime: aspirational now, growing.** During the internship, daytime use is light; at school in a few months it becomes easy → design daytime capture as frictionless-but-optional, ready to scale up.
- Goal: minimum morning + night; ideally ≥1 daytime touch, trending to several.

---

## 2. The capture mechanic

**Governing principle: capture raw and fast, enrich later.** The instant capture asks for a decision (category, estimate, due date) it costs more than remembering — and I go back to keeping it in my head. Capture takes a bare thought; structure is added later, in a calmer pass.

### The model
- **One universal capture bar**, always present on the home and focusable from anywhere via a global hotkey (web-first). On phone it's a persistent bar (bottom, thumb reach).
- **Mode toggle** decides routing: `[ Log | Task | Idea ]`, click or **Tab**-cycle, **Enter** submits. Nothing to memorize, always visible, keyboard-fast.
- **Default = Log.** With no action, plain text drops a timestamped entry into today's interstitial log. The effortless default → the log builds itself, which is also the reflection substrate.
- **After submit:** bar stays focused and **keeps its mode** (since 2026-10-04: batch-entering tasks or ideas re-picked the mode every time); Log is still the default on open.

### What each mode creates
- **Log** → timestamped entry in today's timeline. No other fields.
- **Task** → **title only, unscoped**, into a backlog. Scoped later in the morning pass (estimate + buffer nudge → feeds the estimation-bias calibration). *Optionally*, a ` | ` after the title takes one line of the bulk-add token grammar (`memo | ~30 #Admin due:2026-10-03`) — see [bulk-add.md](../areas/tasks/bulk-add.md). Without one, Claude Haiku reads any structure you typed naturally (`aperture, fix x due fri 30m`) — see [quick-add.md](../areas/tasks/quick-add.md).
- **Idea** → inbox, triaged whenever.

### Hard rule
Capture **never** asks for structure. No estimate, no due date, no category *prompt* at capture time — enrichment is otherwise a separate, later action. This is what keeps capture cost below memory cost, which is the whole game.

*Amended 2026-09-28:* Task mode accepts optional inline tokens after ` | `. Nothing prompts for them and a bare capture costs exactly what it did, so the rule's point — capture never *asks* — stands. A malformed token refuses the submit with an inline error and keeps the text; capture never fails silently.

*Amended 2026-10-12:* Task mode parses natural language with Claude Haiku ([quick-add.md](../areas/tasks/quick-add.md)). Still nothing is asked: you type what you'd say, a bare `buy milk` comes back as itself, and Enter stays one gesture (the parse runs behind the cleared field; a failed parse saves the line as typed, and says so). Review (✨) is the opt-in look-before-saving.

---

## 3. The glanceable home

**Principle:** ≤5 elements per view, glanceable in ~2 seconds. The home **changes by time of day — auto by the clock, with a manual override.** Three modes.

### ☀️ Morning — plan the day (the anti-overconfidence surface)
1. Capture bar (Log default)
2. **Plan today** — pull backlog tasks in, set estimate + buffer on each → shows **planned hours vs hours actually available** ("11h planned into a 6h day"). Under-scoping gets caught here, before it becomes stress. Also holds the **Rolls picker** — pick 1–2 deadline-free efforts for today; each drops a rep onto the plan (see 4b).
3. Habits due today
4. One-line intent (optional, non-scored)

Plus, once a bank is connected, a single **finance line** (budget left · N to sort) — a line, not an element (see 4b).

### ⚙️ Daytime — do + capture (light now, grows at school)
1. Capture bar (prominent)
2. **Right now** — the **Big 3** (top of today's plan) with the in-progress task as a **hero** showing a calm **count-up vs its estimate**; the rest of today falls to a lighter "Also today" lane. Pomodoro focus starts from the hero. Finishing returns a gentle "what's next?", never an auto-advance.
3. **Coming up** — a capped, soonest-first **deadline radar** (from due dates), flat and quiet — you plan *from* it, it never scolds. (The full grouped this-week's-dues view is a later, deep view.)
4. Time-budget glance — hours spent vs planned (running calibration)

### 🌙 Night — log + reflect (the honest mirror)
1. Capture bar (Log mode)
2. **Today in review** — log timeline, tasks done vs planned, **estimate vs actual** side by side
3. Habits check — mark today's
4. One reflection prompt — single rotating question, non-cringe, fully skippable

Plus the **finance line** only while charges wait to be sorted ("N charges to sort", see 4b), and a **Flux line** only on a day with neck-rehab sets ("Flux · 2 sets rotation, 1 upper trap", linking to its History — [flux](../areas/flux/index.md) D51). Lines, not elements.

### Deliberately kept off the daily home
- **Balance / non-work life** lives on a **weekly cadence, not the daily home.** A gentle weekly look ("this week ran 90% work — worth a nudge?"), never a daily checkbox — that would be the guilt-nag the identity forbids.
- **Resurfacing** (a past entry surfaced at night) is a **v1.1 layer** — it needs weeks of data before it has anything to say.

---

## 4. Modules

### 4a. Tasks + estimation calibration (the signature feature)

**Lifecycle:** `backlog → planned → in_progress → done` (or `cancelled` at any point).
1. **Captured** — title only, unscoped, in backlog.
2. **Scoped** (morning pass) — add **estimate** + **buffer** + **category**. Scheduled onto one or more days (**multi-day** supported) with a manual **sort order**. Estimate stays editable at any open status (rescoping mid-task is fine).
3. **Worked** — time accrues; the **calibration baseline freezes at start-of-work** (so hindsight can't launder the calibration) — a later rescope moves only the working estimate. Work that turned out bigger is **split**: this part finishes or keeps going, and the rest becomes another part ([split.md](../areas/tasks/split.md)).
   - **Parent + parts** ([parts.md](../areas/tasks/parts.md)): when something is due differs from when it's worked on, a task is the **deliverable** (the parent: the deadline, done when submitted) and its **parts** are the work (planned, worked and measured on their own). One level deep.
   - **Marking the parent done:** refused while a part is open; one tap once every part is dealt with.
   - **Calibration at two levels:** each part, and the whole job (the parent's lock vs Σ its parts — a missing part shows up there).
4. **Done** — **actual time** recorded, plus an optional **reflection** line (what went well, what to do differently — [reflection](../areas/tasks/reflection.md)) → estimate-vs-actual delta captured, with its why. `cancelled` tasks are excluded from calibration.

**Recurring tasks** — a task can recur (simple rules: daily / weekdays / weekly / every-N), with a **cadence**: each occurrence is planned on its day and due a set number of days later ("pre-lab every Tuesday, due Wednesday"), and the series can **end** on a date (the quarter's last lab). Each occurrence is its own instance with its own estimate/actual → its own calibration point; unplanning one defers it, never duplicates it. Distinct from **habits** (recurring *behaviors*, no estimate). Design: [areas/tasks/recurring.md](../areas/tasks/recurring.md).

**Actual-time measurement — hybrid:** on "done," prompt for one number, **prefilled from any pomodoro time tracked, editable.** Works even on days no timer ran, so calibration data stays complete. An honest manual guess still calibrates fine.

**Rollover:** an unfinished planned task rolls back to backlog — no penalty, but repeated rollovers stay visible as an honest signal, never a scold.

**Calibration payoff:** per-task delta shows in the night review; an aggregate estimate/actual ratio + trend is meaningful only after weeks of data (present early, but honestly sparse). The buffer suggestion starts flat (e.g. +25%) and later personalizes to my measured bias.

### 4b. The lighter modules

- **Interstitial log** — timestamped, append-only, one day per page. Light edit allowed (fix a typo); **no backdating** in v1. The durable reflection substrate.
- **Pomodoro** — configurable work/break (default 25/5), tied to the current task; sessions accrue time + category to the task and prefill its "actual." Minimal.
- **Habits** — weekly-cadence ("3×/week"), calendar view, marked in the night check. **No consecutive-streak, no guilt** — a miss is just a miss, repair-friendly. **Habits may hold non-work items** ("call home 1×/week") — this is the gentle, non-policing way non-work life gets a presence (weekly + repair-friendly keeps it supportive, not a scold).
- **Rolls** — deadline-free ongoing *efforts* you keep returning to (LeetCode daily, study, work on Aperture). Each has a **forgiving momentum "contact sheet"** — a dot grid that only fills; a gap is a fainter dot, **never a resetting streak, red, or score**. A "rep" is a completed *task* tagged to the roll (derived, never a stored counter), so calibration rides ongoing effort too. The morning picker drops a rep onto today's plan, where it flows into the daytime Right-now lane. Distinct from Habits (a *timed task* vs a *binary check*). Full design: **[home/rolls.md](../areas/home/rolls.md)**.
- **Flux** — guided neck exercises with live range-of-motion feedback from the front camera (a port of flux-track-2). Tracking runs on-device; no video ever leaves it. **Not a medical device** — angles are relative to a per-session neutral. A session counts as a **Roll rep** (the Roll is picked in Settings), so neck work rides calibration with no new machinery. Off the daily home. Full design: **[flux/](../areas/flux/index.md)**.
- **Quick-capture inbox** — where Idea-mode captures land; triage each into task / log / note / discard.
- **Recruiting** — a two-tab hub for interview prep.
  - *Attempts* — LeetCode attempt capture. Every submission is recorded, **accepted and wrong**, by a browser extension; there's no authoring here. The list shows a derived per-problem attempt count ("attempt 2 of 2"), so the wrong→accepted arc is the visible unit — the same estimate-vs-reality move as calibration, applied to problem-solving. **No streaks, and a wrong answer is never red** — accepted reads positive, everything else reads "attention." Full design: **[recruiting/](../areas/recruiting/index.md)**.
  - *Stories* — a **behavioral story bank**: ~8–12 STAR stories tagged by competency. The one place the app is structured-at-entry, on purpose — a story is a slowly-tightened artifact you reuse across interviews, not a fleeting capture. Full design: **[recruiting/story-bank.md](../areas/recruiting/story-bank.md)**.
  - Deliberately off the daily home; it's a review surface, not a ritual one.
- **Finances** — where the money went this billing period. Bank of America syncs in (Plaid) and every
  charge gets sorted into **Parents pay · Budget · I pay**; only Budget counts against the per-period
  budget ($600). Money out that isn't spending (moving money into investments, a cash withdrawal) goes to **Not
  spending**, in no total. You mark the card payment that ends a period, link refunds to the charges they
  reverse, and teach it rules ("always put Uber in I pay"). Sorting is a batch pass (keys 1–4), not a per-charge
  chore. The home gets **one line, never a card** — budget left + what's waiting to sort in the morning,
  the sort count at night — because Morning is at its ≤5-element cap. Full design:
  **[finances/](../areas/finances/index.md)**.

### Categories
Tasks + pomodoro sessions carry a category (drives the time-budget glance + weekly balance view). Starting set (editable): **deep work · admin · learning · health · people.** Collapsible to just work / non-work if the fuller set is too much.

---

## 5. Aesthetic

**Direction: quiet modern** — clean, muted, lots of air — but committed to specifics so it never drifts generic (the failure mode of the last build).

**Palette — anchored to `localNotes/preview.webp`** (a muted, desaturated dusky teal-green the user chose):
- **Dark theme (night):** deep desaturated teal-green ground, soft off-white text, translucent teal for selection/active states.
- **Light theme (day):** derived to match the same family — pale warm off-white with a faint sage tint, deep teal-green-gray text. The "lights-on" version, not a different look.
- **Signature accent: warm gold/amber** (the light catching the birds' wingtips in the image), used sparingly. Cool teal base + one warm point of light = the *Aperture* identity (light through an opening).

**Auto theme follows the home mode:** light in morning/daytime, dark at night — the app changes character with the day and reinforces the ritual.

**De-generic commitments (locked):**
1. Not system-default type — a quality neutral sans with slight warmth/character.
2. One restrained signature accent (the gold), used sparingly — never default dashboard-blue.
3. Density discipline — airy overall, but data blocks (tasks, estimate/actual, time) stay crisp and tight, so it reads *considered*, not empty.

---

## 6. Non-goals for v1

**v1 in scope (the daily driver):** capture bar (Log/Task/Idea) · interstitial log · tasks with estimate/actual calibration · pomodoro · habits (weekly-cadence, may hold non-work) · rolls (deadline-free efforts, forgiving momentum) · quick-capture inbox · finances (the three-bucket budget, one home line) · three-mode glanceable home · auto teal/gold theme. Online-first, multi-device (item 7 below). That's it. The bar for v1 is: **it earns the morning + night ritual.**

**Parked for later (ordered by likely arrival):**
1. **Weekly balance view** (work vs non-work split, gentle nudge) — v1.1, the *first* thing after v1. In v1, balance lives entirely through **habits** (the non-work-habit vehicle); the analytical weekly view comes once a week of category data exists.
2. **Resurfacing** — surfacing a past entry at night. Needs weeks of data.
3. **AI reflection** — boundary-triggered LLM that reads across entries and asks one good question. AI is greenlit, just not day one.
4. **Richer calibration** — personalized buffer from measured bias, trend analytics. v1 keeps per-task delta + a simple aggregate ratio.
5. **Quarterly / annual cadence** — v1 has the daily loop only.
6. **Calendar integration** — v1's "hours available" was a manual daily capacity number, not calendar-derived. Since built: **[calendar/](../areas/calendar/index.md)**.
7. **Offline data editing** — v1 is online-first (DynamoDB is the source of truth, so multi-device sync is automatic — laptop + phone share one store). Full offline editing + a sync-on-reconnect write queue is deferred.
8. **Deeper reflection modules** — decision journal, commonplace book, intentions-as-module, values, future-self letters. The task-estimation calibration already delivers the "data about my own overconfidence" hit in v1.

**Never:** XP / badges / levels · guilt-streaks · daily policing of non-work life · storing mood as a number.
