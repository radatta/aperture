# Life areas

**Area:** tasks · **Branch:** `life-areas` · **Built:** 2026-11-05

An **area** is the part of life a category belongs to — **School · Aperture · Recruiting · Personal** — set
once in Settings. It is the axis orthogonal to category: categories are already project-shaped (Aperture,
CS 101, MATH 200, Studying), and the area is what groups them when the question is "how is my time split
across my life", not "which course". Its first job: the Backlog shows the **life backlog**, with Aperture
work folded away behind a chip, and Home's "+ Add" counts only life tasks. The weekly balance and PR-D can
split time by area next. One half of the "Suggested tasks" decision (the Park half); the Suggest half is its
own plan.

Code: `packages/shared/src/areas.ts` (the set, labels, `areaOf`, `LIFE_AREAS`), `types.ts` `Category.area`,
`api.ts` `setCategoryArea` + `UpsertCategoryInput.area`, `lambdas/src/backend.ts` / `app/src/data/stubClient.ts`
(the writes), `lambdas/src/mcp/tools.ts` (`area` on the category tools), `app/src/modules/tasks/query.ts`
(`TaskQuery.areas`, the Backlog preset, `areaCardCounts`, `toggleArea`), `QueryControls.tsx` (the chip),
`app/src/data/hooks/useBacklog.ts` + `AddToTodayDialog.tsx` (the life backlog), `app/src/pages/Settings/index.tsx`
(the Area… panel). Devcheck: `scripts/src/devcheck/scenarios/areas.ts`.

## 1. Model

```
Category ──── area: 'school' | 'aperture' | 'recruiting' | 'personal' | null
   ▲                                   │
   │ categoryId                        └── null (or a row from before the field) reads as Personal: areaOf()
 Task  ──── no area of its own: its category's
```

- **On the category, not the task.** The task record stays as is (voice already says a category), every task
  gets an area the moment its category does, and "park a dev ticket" = give it the Aperture category. Undo:
  drop the field; nothing else reads it.
- **A fixed set.** `AREAS` in `areas.ts`, with labels and display order; a fifth value is one line there. No
  user-editable registry — four names you set once don't need a table.
- **`null` reads as Personal.** `areaOf(category)` is the one place that happens; a task with no category is
  Personal too. Rows from before the field read back `undefined` and both impls list them as `null`, so a
  reader never sees three states. No migration.
- **Live, never snapshotted.** `isWork` stays as it is (snapshotted onto sessions as `wasWork` for the time
  budget); the area is a grouping read live, like the label — change it and history regroups. Calibration
  reads it the same way: the Aperture area is its own calibration lane ([dev-lane](../calibration/dev-lane.md)).
- **A course is a School-area category**, not a second entity (the `courseId` memo's won't-do): per-course
  calibration is per category, balance is per area, and a course ends by retiring its category — it keeps
  its area, so an old term's time still lands under School.

## 2. Surfaces

- **Settings → Categories.** Each row reads its type and area ("Work · School", under the rename box, so
  the arrows and menu keep the line at 390); the row menu's **Area…**
  opens an inline panel of four chips, the current one pressed. A tap is one write (`setCategoryArea`),
  nothing to backfill, and the panel closes; a failure keeps it open with the inline error. The new-category
  form has an Area select beside Type (default Personal).
- **Backlog** (lenses.md D14). The preset shows the life areas (`LIFE_AREAS`: every area but Aperture). The
  Aperture-area cards wait behind a toggle chip **"Aperture · N"** in the chips row — pressed while shown. It
  lives in the session query (D4: sticky for the session, reset each day), it widens rather than narrows so
  it is no override chip and never counts toward "Filter · N", and Clear / Reset to lens fold it back. A
  search ignores the fold: typing finds everything (D1). A part whose parent is in the same place is in its
  parent's area (as it is in its place — `areaOfOwner` keys on the place, not on the parent surviving the
  other filters): the card is one thing, hidden or shown whole, and counted once by the parent; a part
  standing alone (its parent on today's plan, say) reads by its own category. Today and
  Week never filter by area — a dev ticket due Friday is due Friday.
- **Home "+ Add".** `useBacklog` (the "N waiting in the backlog" count) and the picker's unsearched list
  apply the same life predicate (`lifeFrom`, `areas.ts`) — the hook adds "backlog, untimed, no parent", the
  picker "open, not on today"; typing in the picker still finds anything, and a task added while typing
  stays listed. The count waits for the categories roster, so it never starts high and drops; if the roster
  read fails, every task reads as Personal, so the count isn't blank for want of categories.
- **MCP.** `create_category` and `update_category` take `area` (the enum; `null` clears on update),
  `list_categories` returns it. The tool text says the Backlog folds Aperture away, so "park this" has a
  recipe.
- **API.** `setCategoryArea(id, area)`: a value off the set is refused before any read, so nothing is
  written; an unknown or another user's id is not found. `upsertCategory` takes `area` patch-style
  (omitted keeps it), so a rename or a retire never clears it.

## 3. Decisions (2026-11-05, autonomous — `localNotes/decisions.md` on the branch has the undo for each)

1. Area filter off during a search (D1 wins: find-the-thing never depends on a hidden area).
2. The chip is a toggle with `aria-pressed`, drawn only when N > 0, counting cards in the lens by area
   (`areaCardCounts`) whatever the query shows — so the number is "how much Aperture work is waiting", not
   "how much this filter hid".
3. `useBacklog` joins categories and holds its list back while the roster loads; a failed roster reads as
   Personal (the same fallback as no category).
4. "Legacy undefined → null" is proven per impl (a raw row in the Lambda test, a persisted store in the
   stub test) — the contract suite can't write a row without the field. Ownership is a two-user Lambda test.
5. The stub seed gives Deep Work the Aperture area and Learning School, so the Backlog has something to fold.

## 4. Deferred

- The weekly balance by area (PR-D) — reads `areaOf` over sessions' categories live; nothing to migrate.
- Auto-suggest category (`01M455ZMVX1H8DH5KANJ00YVS3`) rides this: a suggested category brings its area.
- A per-area colour or icon on the row. Not until the balance view needs one.
