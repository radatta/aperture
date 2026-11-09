# Evaluating changes & new features — simulate real day-to-day use

**The rule:** before recommending, designing, or shipping any business-logic change or new feature,
simulate how it lands in the user's _actual daily use_ of Aperture — does it move the original goals in
practice, not just fit the architecture or the stated philosophy on paper. Architectural fit and
philosophy-fit are necessary, not sufficient. A feature can be a clean derived read-only method that
mirrors `getCalibration` perfectly and still be dead weight if it never changes a real day.

Apply this to both directions: new features _and_ changes to existing business logic (a scoping rule, a
bucketing choice, a default). Ask "what does this do to a normal Tuesday for the user?" before "is this
clean?"

## The current gap: there is no usage baseline yet

As of 2026-08-09, there is **no lived-in usage baseline**. The user hasn't used Aperture enough to know
their own patterns yet, and neither has the assistant — the user has said as much. Consequences:

- Any fit judgment made without usage data is **provisional**. That explicitly includes the whole
  `localNotes/lifeOsIdeas/` batch and the Pattern Surfacing evaluation — all scored _architectural +
  philosophical_ fit, none scored real-world impact. Treat their verdicts as "worth considering," not
  "validated."
- **Prefer waiting for real usage or an explicit user signal** before committing to any feature whose
  value depends on how the user actually works — especially insight/analytics/resurfacing/correlation
  features, whose entire payoff is usage-shaped.
- When a recommendation is running on abstract fit rather than lived use, **say so out loud** rather than
  presenting it as proven. Don't manufacture a baseline that doesn't exist.

## This will evolve — keep this doc as the living baseline

This understanding is expected to change. As the user reports how they actually use Aperture — what they
capture, which modes (morning/day/night) they open, what they ignore, where friction shows up, what they
wish existed mid-flow — record it below so future evaluations have a real baseline to simulate against.
Until the user fills this in, assume little and ask.

### Observed usage baseline (append as the user shares it)

- **2026-09-23 — voice capture is a real surface.** The user adds tasks by voice through the Claude app
  (Action Button → voice mode → MCP connector). When simulating a feature, also simulate it as one spoken
  sentence with no screen; design implications live in
  [areas/mcp/index.md → Voice](../areas/mcp/index.md#voice--a-live-capture-surface-no-code-of-its-own).
