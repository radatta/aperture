# Calendar integration — design notes (pre-build research)

**Status: research record, 2026-09-14.** This is the thinking that preceded PR-C, kept so the reasoning
and the unbuilt vision aren't lost. **What actually shipped is in [index.md](index.md)** — read that for
the as-built system. Where this doc and index.md disagree, index.md wins; the notable divergences from
this early sketch are called out inline so the record stays honest:

- **Scope: shipped `calendar.events` (read + write), not the `calendar.events.readonly` sketched here.**
  The product decision moved to writing real events onto real calendars (add-to-calendar), so read-only
  was dropped. (Consequence: `calendarList.list` isn't granted by that scope → primary-calendar-only; see
  index.md.)
- **Multi-account, not single-grant.** Shipped two first-class OAuth grants (personal + school), each
  read+write; this doc assumed one read-only grant.
- **Pieces 1–2 shipped** (calendar shape; the commitment framing is implicit in the shape). **Pieces 3–4
  (estimate-time multiplier, night reconciliation) are unbuilt** — they're the PR-D "Calibration Payoffs"
  vision, gated on real usage history. Everything in §2 Pieces 3–4, §5 Don't build, and the behavioral
  findings below is still the live plan of record for that work.

---

## 1. The finding that reframes it

**Retrospective calibration views don't change behaviour.** Buehler, Griffin & Ross (1994) tested exactly
this: subjects who reviewed their own past task durations and were told to "keep them in mind" showed
**unchanged** bias. Only those who additionally constructed a scenario linking the past cases to _the task
in hand_ lost the bias. The Personal Software Process — predict, log actual, analyse the deviation, which
is almost exactly our loop — showed **no accuracy improvement** in two independent studies (Prechelt &
Unger 2001; Abrahamsson & Kautz 2006).

So the calibration view is the **data source**, not the intervention. The intervention belongs where you
type the estimate.

**Honest limit:** every successful debias in this literature removed _bias_ while leaving _absolute error_
unchanged. We can straighten the lean; we can't make estimates precise. Don't write copy promising
accuracy.

---

## 2. What to build

### Piece 1 — calendar shape, not "hours free" — SHIPPED (see index.md)

A day with 5h40m free in gaps of 45/30/60/25 min holds no deep work. A day with 3h free in one block
does. **Total free time tells you nothing; the shape decides the day.**

```
3h 15m committed · 5 meetings
Longest free stretch  3h
4 gaps under 45m
```

No single capacity number, and **no "effective hours" coefficient** — there is no credible peer-reviewed
value for the usable fraction of a fragmented gap. (The ubiquitous "23 minutes 15 seconds to refocus"
appears in no paper; it traces to press interviews. The real published figures are ~11 min working
spheres, 57% interrupted — Mark, González & Harris, CHI 2005.) Showing the shape is honest; showing
"3.2 effective hours" is fabricated precision.

Buildable today. No data dependency.

### Piece 2 — the commitment line

Durations are right-skewed, so **summing per-task medians underestimates the day total even when every
individual estimate is unbiased.** Real data: 443 IT tasks where more estimates were pessimistic than
optimistic (215 underran vs 196 overran) — total still came in 15% over. A 4,000-project study: median
overrun ~0%, mean overrun 107%.

```
Planned      3h 00m
Expect       3h 40m – 4h 10m
Open time    3h 15m
```

This is the anti-overconfidence surface **blaming arithmetic rather than the user**, which is what the
no-guilt constraint needs. Not a threshold gauge, no red, no warning icon. Needs per-category _spread_,
not a point ratio.

### Piece 3 — the multiplier at estimate time — UNBUILT (PR-D)

```
Estimate [ 90 ] min
         deep work runs ~1.6× → likely 145m
```

The user's number is never overwritten. Shrink toward the category middle — the more uncertain, the more
you shrink (Halkjelsvik & Jørgensen). Precedent: HM Treasury's Green Book mandates per-category optimism
uplifts and starts at the upper bound, reducing only as specific risks are identified. Joel Spolsky's
Evidence-Based Scheduling keeps the whole _distribution_ of estimate÷actual ratios per person, not a mean
— worth copying, along with discarding history older than ~6 months.

### Piece 4 — night reconciliation (later, highest risk) — UNBUILT (PR-D)

Calendar says a 90-min meeting ran; the log is silent 1:40–4:10 → offer to log it. Genuinely novel
(nobody ships it) and it recovers calibration data that currently evaporates.

**But it is a nightly failure report by construction.** Epstein et al. (CHI 2016) found "discomfort with
information revealed" is a top reason people abandon self-tracking, with 16% reporting guilt. Mitigation:
for anything unfinished, ask _"when?"_ rather than scoring it — forming a specific plan discharges the
rumination about as well as finishing does (Masicampo & Baumeister 2011; note that's a Baumeister-lab
result from the ego-depletion era, so treat as plausible, not established). Never show a completion
percentage. Never show a streak.

---

## 3. Technical shape (superseded — see index.md for as-built)

The early technical plan below sketched a **read-only, single-grant** design. PR-C shipped a **read+write,
multi-account** design instead (add-to-calendar writes real events; two accounts each with their own
grant). The rows kept here are the ones that still hold or that explain _why_ a choice was made; the
scope/read rows are historical.

| Decision  | Early choice (some superseded)                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------ |
| **Auth**  | **Separate** Google OAuth grant run by the BFF — _not_ Cognito federation. **(Held.)**                 |
| **Scope** | `calendar.events.readonly`. **Superseded → `calendar.events` (read+write).**                           |
| **Read**  | `events.list` with `singleEvents=true` — **not** `freebusy.query`. **(Held.)**                         |
| **Token** | SSM Parameter Store SecureString, `/aperture/<env>/google/*`. $0. **(Held.)**                          |
| **Sync**  | On-demand at app open. No push channels, no `syncToken`. **(Held.)**                                   |
| **Cache** | 5–15 min, explicit `fetchedAt`. Calendar data is never source of truth. **(Held — client staleTime.)** |

**Cognito federation cannot do this.** AWS: the OIDC IdP flow "doesn't allow the user or application to
see the IdP-side tokens." Cognito consumes Google's tokens to establish identity and issues its own. The
custom-attribute workaround captures a token only at sign-in and never refreshes — useless for an hourly
token. So it's a second, explicit "Connect Google Calendar" grant, with the callback on our own origin
(`/api/google/callback` → CloudFront → Function URL, same-origin, no CORS).

`freebusy.query` returns opaque intervals only — it throws away `eventType: focusTime` and declined-invite
status, which are exactly what we need.

**Writes discipline:** the token exchange, the token refresh, and the `PutParameter` that persists a
rotated token are all external writes and belong behind the gated seam. This is genuinely protective — it
structurally stops a test run from burning a refresh token or marching toward Google's
**100-refresh-tokens-per-account-per-client** cap, past which Google silently invalidates the oldest.
(Shipped as the `GoogleGateway` seam — see index.md.)

---

## 4. Traps

**The 7-day one.** A Google OAuth consent screen in **"Testing" status issues refresh tokens that expire
in 7 days** (Calendar scopes aren't in the exempt subset). It would work beautifully for a week, then die
silently as an `invalid_grant` on a background refresh — the same bug class as the daily Cognito
re-login. **Publish the consent screen on day one** (accept the unverified warning + 100-user cap), or use
**Internal** user type on Workspace, which sidesteps it entirely. Google's docs don't affirmatively state
that Production-but-Unverified gets long-lived tokens, so **verify empirically on day 8–10** before
trusting the morning ritual to it.

**The statistical one.** **Never bucket calibration stats by _actual_ duration.** Doing so reports "you
underestimate big tasks" as a **pure regression artifact with no underlying truth** — 7 of 7 studies that
keyed size on actual time found the effect; studies keying on _predicted_ time found little or none.
Bucket by estimate, and present the ratio distribution per category rather than a size-sliced trend.
(This is a load-bearing constraint for PR-D.)

**Normalization is the highest-volume bug source**, and it fails quietly — the output is a
plausible-looking number, not an error. `start.date` vs `start.dateTime` are two shapes under one field
name; `end.date` is exclusive; declined invites silently inflate "how busy am I"; DST days aren't 24
hours. Fixture-test against a recorded real response containing each edge case. (Shipped — see
`lambdas/src/google/normalize.test.ts`.)

---

## 5. Don't build

- **Write-back / two-way sync.** Highest complexity, highest blast radius, least value for one user. Once
  you write events you own their whole lifecycle, including after uninstall. _(Note: PR-C does write
  events, but Aperture owns only the events it created and deletes them on cancel. Two-way sync shipped
  2026-10-05 **for those events only**: a pull-based read of Google edits to Aperture-created events
  back onto their tasks — never adopting other events, never writing to Google from the pull
  ([index.md](index.md) → Two-way sync). The warning still holds for full sync of arbitrary calendar
  state.)_
- **Auto-scheduling.** Reproduces Motion's worst failure (packs the day, leaving no room for the
  unplanned). Also: **Clockwise shut down 27 March 2026** — the flagship calendar-defragmentation product,
  $76M raised, killed in an acquihire. Auto-scheduling is where this category struggles.
- **A calendar grid inside Aperture.** Google Calendar already exists. This should be _numbers and one
  sentence, never a view_.
- **Habit auto-detection from calendar events.** That's daily policing of non-work life — an explicit
  stated non-goal.
- **Live "you're running over" nudges.** Leroy (2009) found attention residue is _worse_ when the prior
  task was time-pressured, so this would actively degrade the next block.
- **"Your best hours" / chronotype inference.** One person's task volume against lognormal spread will
  produce confident patterns that are noise.

---

## 6. Order and dependency

1. **Calendar shape** — buildable today, no data needed. **(Shipped, PR-C.)**
2. **Commitment line** — needs a few weeks of actuals to be honest.
3. **Estimate-time multiplier** — same dependency.
4. **Night reconciliation** — last, and only with the framing above.

2, 3 and 4 are gated on real usage history, which is the same thing the 9.2 stub-validation gate produces
— i.e. they are the **PR-D** work.

**Key sources:** Buehler/Griffin/Ross 1994 (_JPSP_ 67:366–381) · Halkjelsvik & Jørgensen, _Time
Predictions_ (Springer 2018, open access) · HM Treasury Green Book optimism-bias supplement · Mark/
González/Harris CHI 2005 · Leroy 2009 (_OBHDP_ 109:168–181) · Epstein et al. CHI 2016 · Spolsky,
Evidence-Based Scheduling (2007) · Google Calendar API + OAuth 2.0 docs.
