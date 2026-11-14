# Aperture — Product Spec

Personal life-OS PWA. Web-first, installable to phone. One codebase, both surfaces.
Status: built — see [`docs/index.md`](../index.md). Started: 2026-08-02.
Versions: **v1** is the ritual app — [`V1_PLAN.md`](../V1_PLAN.md) phases 0–14, designed in §1–§6 below. **v2** is everything shipped since, mapped in §7; each piece's design lives in its `areas/` doc.

---

## 1. Identity

**One line:** Aperture is the single aperture a person's whole digital life passes through — the place to plan, do, capture, and later look back through.

**Who it's for:** one person, specifically — someone motivated and ambitious who can lose the wider view when deep in work. They want to be more mindful _without_ sacrificing output — a work/life balance that comes from wanting it, not from forcing it and resenting it.

**The job it does:** get everything out of the user's head and into one trusted place, so there is less to carry, time gets scoped honestly, and weeks or months later the patterns that are invisible in the moment can be seen.

### The core tension it must hold

Stay ambitious and productive **and** get more mindful/balanced — with a hard rule: **balance can't be enforced by guilt.** If the app ever makes "call a friend" or "rest" feel like a chore being failed, it has broken its own premise. Non-work life is invited, never policed.

### Why earlier versions of this app failed (design against these)

1. **Inconsistency, not features.** The functionality existed and still lost to habit: the task list drifted back into the user's head and the morning/night check-in lapsed. → **The #1 job of v1 is to earn a daily ritual without relying on willpower.** No guilt-streaks (they invite rebellion or bad feeling); the pull has to be that the home is genuinely worth opening.
2. **Bland UI.** Pre-AI, all the effort went to function, and nothing about the app invited a return. → Smooth, quiet, considered UI is a v1 requirement, not polish-later.

### Two premises that define the product

1. **The bar to beat is the user's own memory.** Keeping tasks in one's head "works" for completion — so Aperture's value prop is _not_ "get more done." It's **less stress + honest scoping.** That reframes success: the win is a calmer head and realistic plans, not a higher task count.
2. **The user under-scopes and doesn't buffer — overconfident even when aware of it.** → Tasks should capture **estimate vs actual time**, and the app should quietly show the user their own estimation bias over time. This is the decision-journal / calibration idea aimed at the planning fallacy — and it's the product's version of "mindfulness": data about one's own overconfidence, not a mood emoji.

### Derived design principles

- **Earn the open.** Every surface answers "why is the user glad they opened this," or it's cut.
- **Frictionless capture beats rich capture.** Getting a thought in must cost near-zero, or the thought stays in the user's head.
- **Invite, don't police** non-work life. Balance is surfaced gently, never scored or streak-shamed.
- **Reflect the user back to themselves** — estimation bias, past entries, patterns — as _evidence_, not judgment.
- **Quiet, field-notebook aesthetic.** Closer to a terminal or a good notebook than a pastel app.

### v1 usage model

- **Anchors: morning + night** (guaranteed touchpoints). The home should have a distinct **morning mode** (plan/intent) and **night mode** (log/reflect).
- **Daytime: aspirational now, growing.** Daytime use starts light and is expected to grow → design daytime capture as frictionless-but-optional, ready to scale up.
- Goal: minimum morning + night; ideally ≥1 daytime touch, trending to several.

---

## 2. The capture mechanic

**Governing principle: capture raw and fast, enrich later.** The instant capture asks for a decision (category, estimate, due date) it costs more than remembering — and the thought goes back to being kept in the user's head. Capture takes a bare thought; structure is added later, in a calmer pass.

### The model

- **One universal capture bar**, always present and focusable from anywhere via a global hotkey (`/`, web-first). It sits in one fixed bottom dock at every width (thumb reach on phone), shared with the timers.
- **Mode toggle** decides routing: `[ Log | Task | Idea ]`, click or **Tab**-cycle (**Shift+Tab** while token suggestions show, since Tab then accepts one), **Enter** submits. Nothing to memorize, always visible, keyboard-fast.
- **Default = Log.** With no action, plain text drops a timestamped entry into today's interstitial log. The effortless default → the log builds itself, which is also the reflection substrate.
- **After submit:** bar stays focused and **keeps its mode** (since 2026-10-04: batch-entering tasks or ideas re-picked the mode every time); Log is still the default on open.

### What each mode creates

- **Log** → timestamped entry in today's timeline. No other fields, bar an optional one-shot **private** flag ([log](../areas/log/index.md)).
- **Task** → **title only, unscoped**, into a backlog — or, when asked, onto today (→ today, [lenses](../areas/tasks/lenses.md)), onto a store's errand list (`@place`, [places](../areas/tasks/places.md)), or onto its due time's day ([parts](../areas/tasks/parts.md) v2b); the receipt says which. Scoped later in the morning pass (estimate + buffer nudge → feeds the estimation-bias calibration). _Optionally_, a `|` after the title takes one line of the bulk-add token grammar (`memo | ~30 #Admin due:2026-10-03`) — see [bulk-add.md](../areas/tasks/bulk-add.md). Without one, Claude Haiku reads any structure you typed naturally (`aperture, fix x due fri 30m`) — see [quick-add.md](../areas/tasks/quick-add.md).
- **Idea** → inbox, triaged whenever.

### Hard rule

Capture **never** asks for structure. No estimate, no due date, no category _prompt_ at capture time — enrichment is otherwise a separate, later action. This is what keeps capture cost below memory cost, which is the whole game.

_Amended 2026-09-28:_ Task mode accepts optional inline tokens after `|`. Nothing prompts for them and a bare capture costs exactly what it did, so the rule's point — capture never _asks_ — stands. A malformed token refuses the submit with an inline error and keeps the text; capture never fails silently.

_Amended 2026-10-12:_ Task mode parses natural language with Claude Haiku ([quick-add.md](../areas/tasks/quick-add.md)). Still nothing is asked: you type what you'd say, a bare `buy milk` comes back as itself, and Enter stays one gesture (the parse runs behind the cleared field; a failed parse saves the line as typed, and says so). Review (✨) is the opt-in look-before-saving.

---

## 3. The glanceable home

**Principle:** ≤5 elements per view, glanceable in ~2 seconds. The home **changes by time of day — auto by the clock, with a manual override.** Three modes.

### ☀️ Morning — plan the day (the anti-overconfidence surface)

1. Capture bar (Log default)
2. **Day shape** — the calendar's longest free stretch and how fragmented the day is, or a prompt to connect one ([calendar](../areas/calendar/index.md))
3. **Plan today** — pull backlog tasks in, set estimate + buffer on each → shows **planned hours vs hours actually available** ("11h planned into a 6h day"). Under-scoping gets caught here, before it becomes stress. Also holds the **Rolls picker** — pick 1–2 deadline-free efforts for today; each drops a rep onto the plan (see 4b).
4. Habits due today
5. One-line intent (optional, non-scored)

Plus, once a bank is connected, a single **finance line** (budget left · N to sort) — a line, not an element (see 4b).

### ⚙️ Daytime — do + capture (light now, growing)

1. Capture bar (prominent)
2. **Day shape**, clipped to the rest of the day
3. **Right now** — the **Big 3** (top of today's plan) with the in-progress task as a **hero** showing a calm **count-up vs its estimate**; the rest of today falls to a lighter "Also today" lane. Pomodoro focus starts from the hero. Finishing returns a gentle "what's next?", never an auto-advance.
4. **Coming up** — a capped, soonest-first **deadline radar** (from due dates), flat and quiet — you plan _from_ it, it never scolds. (The full grouped this-week's-dues view is a later, deep view.)
5. Time-budget glance — hours spent vs planned (running calibration)

### 🌙 Night — log + reflect (the honest mirror)

1. Capture bar (Log mode)
2. **Today in review** — the latest log entries, every task finished today with its **estimate vs actual** side by side (and its reflection line), then **Still open — when?** for what's left ([lenses](../areas/tasks/lenses.md))
3. Habits check — mark today's
4. One reflection prompt — single rotating question, non-cringe, fully skippable

Plus the **finance line** only while charges wait to be sorted ("N charges to sort", see 4b), and a **Flux line** only on a day with Flux sets ("Flux · 2 sets rotation, 1 upper trap", linking to its History — [flux](../areas/flux/index.md) D51). Lines, not elements.

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
4. **Done** — **actual time** recorded, plus an optional **reflection** line (what went well, what to do differently — [reflection](../areas/tasks/reflection.md)) → estimate-vs-actual delta captured, with its why. `cancelled` tasks are excluded from calibration. **Nothing finishes without both numbers** ([integrity](../areas/calibration/integrity.md)): a task finished unscoped gets its estimate at Done, in hindsight, and is marked as such. Starting one unscoped is a nudge, never a wall. An errand is checked off, not measured ([places](../areas/tasks/places.md)).

**Recurring tasks** — a task can recur (simple rules: daily / weekdays / weekly / every-N), with a **cadence**: each occurrence is planned on its day and due a set number of days later ("a weekly report every Tuesday, due Wednesday"), and the series can **end** on a date (the term's last week). Each occurrence is its own instance with its own estimate/actual → its own calibration point; unplanning one defers it, never duplicates it. Distinct from **habits** (recurring _behaviors_, no estimate). Design: [areas/tasks/recurring.md](../areas/tasks/recurring.md).

**Actual-time measurement — hybrid:** on "done," prompt for one number, **prefilled from any pomodoro time tracked, editable.** Works even on days no timer ran, so calibration data stays complete. An honest manual guess still calibrates fine.

**Rollover:** an unfinished planned task rolls back to backlog when the next day loads, or by hand from Night's _Still open_ (Tomorrow · Backlog · Leave) — no penalty. Repeated rollovers are meant to stay visible as an honest signal, never a scold; that signal isn't built yet.

**Calibration payoff:** per-task delta shows in the night review; an aggregate estimate/actual ratio + trend is meaningful only after weeks of data (present early, but honestly sparse). The buffer suggestion starts flat (e.g. +25%) and later personalizes to the user's measured bias.

### 4b. The lighter modules

- **Interstitial log** — timestamped, append-only, one day per page. Light edit allowed (fix a typo); **no backdating** in v1. The durable reflection substrate. An entry can be **private** (kept out of every MCP read and search), and the log is readable over MCP ([log](../areas/log/index.md)).
- **Pomodoro** — configurable work/break (default 25/5), tied to the current task; sessions accrue time + category to the task and prefill its "actual." Minimal.
- **Habits** — weekly-cadence ("3×/week"), calendar view, marked in the night check. **No consecutive-streak, no guilt** — a miss is just a miss, repair-friendly. **Habits may hold non-work items** ("call a friend 1×/week") — this is the gentle, non-policing way non-work life gets a presence (weekly + repair-friendly keeps it supportive, not a scold).
- **Rolls** — deadline-free ongoing _efforts_ you keep returning to (LeetCode daily, study, work on Aperture). Each has a **forgiving momentum "contact sheet"** — a dot grid that only fills; a gap is a fainter dot, **never a resetting streak, red, or score**. A "rep" is a completed _task_ tagged to the roll (derived, never a stored counter), so calibration rides ongoing effort too (a Flux session and a LeetCode sitting count the same way). The morning picker drops a rep onto today's plan, where it flows into the daytime Right-now lane. Distinct from Habits (a _timed task_ vs a _binary check_). Full design: **[home/rolls.md](../areas/home/rolls.md)**.
- **Flux** _(v2)_ — guided neck exercises with live range-of-motion feedback from the front camera (a port of flux-track-2). Tracking runs on-device; no video ever leaves it. **Not a medical device** — angles are relative to a per-session neutral. A session counts as a **Roll rep** (the Roll is picked in Settings), so Flux sessions ride calibration with no new machinery. Off the daily home. Full design: **[flux/](../areas/flux/index.md)**.
- **Quick-capture inbox** — where Idea-mode captures land; triage each into task / log / discard.
- **Recruiting** _(v2)_ — a two-tab hub for interview prep.
  - _Sittings_ — one go at one problem: the browser extension's Start clears LeetCode's editor and starts its timer, everything LeetCode sends is captured raw, and the rep is marked Done in Aperture. There's no authoring here. The headline is **whether the first submit was accepted** — the same estimate-vs-reality move as calibration, applied to problem-solving — and a sitting is a **LeetCode Roll rep**. **No streaks, and a wrong answer is never red.** Full design: **[recruiting/](../areas/recruiting/index.md)**.
  - _Stories_ — a **behavioral story bank**: ~8–12 STAR stories tagged by competency. The one place the app is structured-at-entry, on purpose — a story is a slowly-tightened artifact you reuse across interviews, not a fleeting capture. Full design: **[recruiting/story-bank.md](../areas/recruiting/story-bank.md)**.
  - Deliberately off the daily home; it's a review surface, not a ritual one.
- **Finances** _(v2)_ — where the money went this billing period. A bank syncs in (Plaid) and every
  charge gets sorted into **Covered · Budget · I pay**; only Budget counts against the per-period
  budget. Money out that isn't spending (a transfer to an outside account, a cash withdrawal) goes to **Not
  spending**, in no total. You mark the card payment that ends a period, link refunds to the charges they
  reverse, and teach it rules ("always put <merchant> in I pay"). Sorting is a batch pass (keys 1–4), not a per-charge
  chore. The home gets **one line, never a card** — budget left + what's waiting to sort in the morning,
  the sort count at night — because Morning is at its ≤5-element cap. Full design:
  **[finances/](../areas/finances/index.md)**.

### Categories

Tasks + pomodoro sessions carry a category (drives the time-budget glance + weekly balance view). Starting set (editable; the stub's seed): **deep work · admin · learning · health · people.** Each category is work or non-work (`isWork`); collapsing to just work / non-work comes with the weekly balance view, not built yet. Every category belongs to a **life area** (School · Aperture · Recruiting · Personal — [areas](../areas/tasks/areas.md)), and the task editor suggests a category from past tasks, tap-only ([task-editor](../areas/tasks/task-editor.md)).

---

## 5. Aesthetic

**Direction: quiet modern** — clean, muted, lots of air — but committed to specifics so it never drifts generic (the failure mode of the last build).

**Palette — anchored to a reference photo** (a muted, desaturated dusky teal-green, chosen by the user; the photo is kept out of the repo, the tokens live in `app/src/styles/tokens.css`):

- **Dark theme (night):** deep desaturated teal-green ground, soft off-white text, translucent teal for selection/active states.
- **Light theme (day):** derived to match the same family — pale warm off-white with a faint sage tint, deep teal-green-gray text. The "lights-on" version, not a different look.
- **Signature accent: warm gold/amber** (the light catching the birds' wingtips in the image), used sparingly. Cool teal base + one warm point of light = the _Aperture_ identity (light through an opening).

**Auto theme follows the home mode:** light in morning/daytime, dark at night — the app changes character with the day and reinforces the ritual.

**De-generic commitments (locked):**

1. Not system-default type — a quality neutral sans with slight warmth/character.
2. One restrained signature accent (the gold), used sparingly — never default dashboard-blue.
3. Density discipline — airy overall, but data blocks (tasks, estimate/actual, time) stay crisp and tight, so it reads _considered_, not empty.

---

## 6. Non-goals for v1

**v1 in scope (the daily driver):** capture bar (Log/Task/Idea) · interstitial log · tasks with estimate/actual calibration · pomodoro · habits (weekly-cadence, may hold non-work) · rolls (deadline-free efforts, forgiving momentum) · quick-capture inbox · three-mode glanceable home · auto teal/gold theme. Online-first, multi-device (item 7 below). That's it. Everything built beyond this list — Finances included, which [`V1_PLAN.md`](../V1_PLAN.md) never planned — is v2: §7. The bar for v1 is: **it earns the morning + night ritual.**

**Parked for later (ordered by likely arrival):**

1. **Weekly balance view** (work vs non-work split, gentle nudge) — v1.1, the _first_ thing after v1. In v1, balance lives entirely through **habits** (the non-work-habit vehicle); the analytical weekly view comes once a week of category data exists.
2. **Resurfacing** — surfacing a past entry at night. Needs weeks of data.
3. **AI reflection** — boundary-triggered LLM that reads across entries and asks one good question. AI is greenlit, just not day one. Since built elsewhere: Claude Haiku parses quick add ([quick-add](../areas/tasks/quick-add.md)) and writes Flux's weekly note ([flux](../areas/flux/index.md)); the reflection use is still parked.
4. **Richer calibration** — personalized buffer from measured bias, trend analytics. v1 keeps per-task delta + a simple aggregate ratio. Since built, in part: the done gate and hindsight estimates ([integrity](../areas/calibration/integrity.md)) and two-level calibration for parent + parts ([parts](../areas/tasks/parts.md)); the buffer is still a flat +25%.
5. **Quarterly / annual cadence** — v1 has the daily loop only.
6. **Calendar integration** — v1's "hours available" was a manual daily capacity number, not calendar-derived. Since built: **[calendar/](../areas/calendar/index.md)**.
7. **Offline data editing** — v1 is online-first (DynamoDB is the source of truth, so multi-device sync is automatic — laptop + phone share one store). Full offline editing + a sync-on-reconnect write queue is deferred. Since built, in part: crash-safe outboxes for capture and for Flux sets ([flux](../areas/flux/index.md)).
8. **Deeper reflection modules** — decision journal, commonplace book, intentions-as-module, values, future-self letters. The task-estimation calibration already delivers the "data about one's own overconfidence" hit in v1. Since built, in part: one optional reflection line per finished task ([reflection](../areas/tasks/reflection.md)).

**Never:** XP / badges / levels · guilt-streaks · daily policing of non-work life · storing mood as a number.

---

## 7. v2 — shipped since v1

Pointers only; each `areas/` doc owns its design and decision log. The whole map is [`docs/index.md`](../index.md).

- **Tasks** — [due dates + times](../areas/tasks/due-dates.md) · [parent + parts](../areas/tasks/parts.md) and [split](../areas/tasks/split.md) · [recurring cadences](../areas/tasks/recurring.md) · [lenses](../areas/tasks/lenses.md) (Today · Week · Backlog · Done) · the [task editor](../areas/tasks/task-editor.md) · [notes](../areas/tasks/notes.md) · [attachments](../areas/tasks/attachments.md) · [reflection](../areas/tasks/reflection.md) · [life areas](../areas/tasks/areas.md) · [calibration integrity](../areas/calibration/integrity.md).
- **Capture** — [quick add](../areas/tasks/quick-add.md) (Claude Haiku parse) · [bulk add](../areas/tasks/bulk-add.md) · [private log entries](../areas/log/index.md).
- **Out in the world** — [places](../areas/tasks/places.md) (errand lists + an iPhone Shortcut) · [reminders](../areas/tasks/reminders.md) (Web Push) · [Google Calendar](../areas/calendar/index.md), two-way.
- **Modules** — [Finances](../areas/finances/index.md) · [Flux](../areas/flux/index.md) · [Recruiting](../areas/recruiting/index.md) (LeetCode sittings + the Safari extension, the [story bank](../areas/recruiting/story-bank.md)).
- **Reach** — the [MCP connector](../areas/mcp/index.md): Claude Code and claude.ai read and write Aperture, with voice capture and a Raycast hotkey.
