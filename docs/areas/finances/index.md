# Finances — the three-bucket budget over Plaid

`/finances`: every charge on the linked bank's cards and accounts, sorted into **Covered · Budget · I pay**, against a **budget per billing period** (a Setting). A port of an earlier budget app, synced through
**Plaid Trial** ($0). This doc is the design record and the one home for the sync-status contract, the
Plaid facts we rely on, and the operator checklist. Built on `feature/finances-page`, 2026-09.

## 1. Shape

- **Page:** `/finances` with tabs **Sort** (the batch queue), **All** (the ledger of the current and
  previous period, with search and a "Sort into" brush — below) and **Rules** — real routes, like Recruiting. It's an AppNav link, not a dock item (one
  dock, [CONVENTIONS](../../product/CONVENTIONS.md)).
- **Home:** one line, never a card (why: [PRODUCT §4b](../../product/PRODUCT.md#4b-the-lighter-modules)).
  Morning: "$X left of $<budget> · N to sort"; Night: "N charges to sort", only when non-zero
  (`pages/Home/FinanceGlance.tsx`). Nothing until a bank is connected.
- **Settings:** budget per period and card payment day (defaults: `FINANCE_DEFAULT_BUDGET_CENTS` and `FINANCE_DEFAULT_PAYMENT_DAY` in `finance.ts`).
- **Header:** budget left, the period and its day, and a nudge to mark a detected card payment — a newer
  payment on a marked period, or on the payment-day fallback the last one (when a card is linked).

### The All tab: sort into and search

- **Sort into** (a brush): press **1–4** or tap a bucket to arm it, then tap rows to sort them one at a
  time — the fix for rows the Sort tab's merchant grouping can't batch (peer-to-peer payments each carry their own name).
  Tapping a row that already has the armed bucket sets it back to Unsorted. Only rows the Sort tab could
  sort take paint (`view.sortable`, minus refunds riding a charge); the rest go inert (`aria-disabled`)
  while armed. No rules from here — **Always** stays a Sort-tab thing. Esc, **Done**, or the armed key
  again stops it. Armed, the bar sticks at the top of the list — below the status-bar inset in the
  installed PWA (`--safe-top`); a focused row keeps a scroll margin of the bar's height, and `html`'s
  `scroll-padding-top` adds the inset, so J/K and the sort queue's focus returns never land a row
  under either.
- **Painted rows stay put** until you stop or change the Show chip or search, so the list never moves
  under your finger (a painted row may no longer match the chip). Each row saves through its own
  per-transaction queue; the refetch waits for the last row's save (`otherEditsInFlight`), so a quick run
  of paints never flickers a tag back.
- **Search** (`/` focuses it on this tab — see CONVENTIONS → Page keyboard shortcuts): a case-insensitive
  substring of the merchant, the bank's descriptor, or the note (`matchesFinanceText`), combined with the
  **Show** chip (`matchesFinanceFilter`). While either narrows the list it shows "N rows · $X", the **net**
  of what's shown (`netCents`: money in subtracts) — the same total the MCP's `totalUsd` uses. Search covers
  the two loaded periods only. While the brush holds painted rows in place, the count includes them even
  if they no longer match the chip; it agrees again once you stop.
- **Linked to older charges**: a refund dated in either period but linked to a charge from before them
  follows the charge out of both lists (`periodOf`), so it's listed in its own section — the only way
  back to it to unlink. The chip and search narrow it, and it counts in "N rows · $X"; the MCP's list
  (`page.txns`) leaves it out.

## 2. Buckets and money

- Buckets `parents_pay` (shown as **Covered**; the stored key keeps its original name) / `budget` / `i_pay` (keys **1 / 2 / 3** on a focused Sort group). Only **Budget**
  counts against the budget; the other two are tracked, not limited.
- **Not spending** (`not_spending`, key **4**) is for money out that isn't spending — a transfer to an outside account,
  a cash withdrawal, a top-up of a payment app. Sorting a row there takes it out of the queue and out of every
  total (`summarizePeriod` skips it; the overview's `buckets` stay the three spending ones). It's a stored
  bucket value, not a flag, so rules, **Always** and pending→posted carry it like the others. Real data
  needs it: an outflow to an account you haven't linked can't pair as a transfer, so it lands in Sort as a
  charge. On **All** these rows stay listed (the ledger matches the bank), muted like transfers.
  `financeBucketError` makes both ApiClient impls refuse an unknown bucket the same way.
- **Sign:** `rawAmountCents` stores Plaid's number, **positive = money out**. Normalisation is read-time:
  `amountOf` applies the account's `signOverride` (`flip`), so flipping an account changes nothing stored.
- **To sort** counts unsorted charges in the current **and** previous period (both are sortable).
- **Kinds** (`classifyTransaction`): `expense` (a charge), `refund` (money into a card), `income` (money
  into checking/savings), `transfer` (between your own accounts), `card_payment`. Only expenses and
  refunds are sortable; a deposit (transfer-tagged or not, unless it paired as a move) counts only once
  linked as a refund.
- **Internal moves** (`detectInternalMoves`) pair a depository outflow with an equal inflow on another of
  your accounts within `PAYMENT_MATCH_WINDOW_DAYS` (3), nearest date first, needing a transfer/loan-payment
  Plaid category (or a period mark) on one side. An unpaired row whose Plaid category is
  `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` still counts as a card payment (the "hint").
- **Hidden accounts** are listed but excluded from every total, the sort queue and refund links. A hidden
  card's period marks still count.
- **A split** (`splits`, a charge only): 2–`FINANCE_SPLIT_MAX_PARTS` (8) parts `{bucket, cents, period}` that
  add up exactly to the charge (`financeSplitError`, both impls), set from the detail's **Split across
  buckets…** (it opens half and half; with two parts the one you haven't typed in follows). Each part counts
  in its own bucket (`countedParts`; a bucket counts the charge once however many parts it holds); the row's
  own `bucket` is null and it is sorted. A bucket chip matches any part, and under it the row counts only
  that bucket's parts (`bucketsOf`, `filterCents`). The brush leaves a split row alone and `setFinanceBucket`
  refuses it ("… is split — change it from its detail"); **Remove split** (`setFinanceSplit(id, null)`)
  returns it to Unsorted. A refund on a split charge comes off its parts in proportion
  (`allocateProportional`: largest remainder, ties to the earlier part), never below $0.
- **A broken split** is decided at read time (`splitOf`): parts that no longer add up to the amount — a
  pending charge posted at a new amount, which Plaid allows — count nowhere; the row is back in Sort as
  "split no longer adds up (was $X)", and its detail says what changed with **Fix the split**. Sorting it
  replaces the split. A rule-made split (parts carry `percent`) recomputes at any amount instead.

## 3. Periods and marks

- **You mark the card payment that ends a period** (money in on a credit account); the next period starts
  the day after it. `periodStartError` is re-checked at read time, so a flipped or moved row stops
  anchoring the period.
- With no valid mark in the 120-day lookback (`FINANCE_OVERVIEW_LOOKBACK_DAYS`), the period falls back to
  the day after `financePaymentDay`. Detection only **suggests** a mark (`suggestPeriodStart`, the header
  nudge) — it never moves the period on its own.
- Marking today's payment leaves an empty current period that starts tomorrow.
- A row can be pinned to **This period** or **Last period** (`periodOverride`), overriding its date.
- **A split's part** has its own period (`periodOfPart`): **With the charge** (`null`, follows the row,
  override and all), **This**, **Last**, or **Next**. Next is relative to the charge's own window: on a
  this-period charge the part waits in no total (`overview.upcoming`; the header says "$X waiting for next
  period"; the row "(next period)") until a later payment is marked; on a last-period charge it counts in
  the current one. A charge outside both windows counts nowhere, pin or not. A whole unsplit charge can't
  be moved to next period yet (§14).

## 4. Refunds

- A refund (card credit, or a checking/savings deposit) is linked to the charge it reverses; it then takes
  the charge's bucket and period, nets against it, and leaves the sort queue. An unlinked deposit is
  income, outside the budget. That includes **someone paying you back** — e.g. a friend paying back their share of a
  bill: Plaid tags it a transfer (`TRANSFER_IN`) because it comes from an account you haven't linked, and
  linking it to the bill nets the bill out.
- `refundLinkError` (run by both the stub and the server; the suggestions filter with its
  `chargeSideError`, so the page never offers a link the server refuses): both sides on shown accounts,
  and the charge dated no more than `REFUND_DATE_SLACK_DAYS` (3) after the refund. The refund side is
  money in that isn't a payment or a period mark, and isn't a move `detectInternalMoves` paired between
  your own accounts — a `TRANSFER_IN` deposit is allowed; `LOAN_PAYMENTS`/`TRANSFER_OUT` money in isn't.
  The charge side stays strict: never a payment or transfer. **Any size:** a refund larger than its charge
  links.
- **The cap** (`capRefunds`): a charge's refunds count in date order (then id), each only up to what's
  left of the charge, so charge + refunds net to exactly $0, never below. The overshoot stays money in,
  outside every total. The row says "counts $X", the detail "Only $X of it counts", and MCP rows carry
  `countedUsd`; a charge's `refunded` (MCP `refundedUsd`) never exceeds it.
- A refund linked to a **Not spending** charge is Not spending too — out of every total, like its charge.
- Suggestions (`suggestRefundMatches`) look back `REFUND_MATCH_WINDOW_DAYS` (90): same-merchant charges
  first, otherwise any merchant, top five. A charge is offered when the refund fits what's left of it, or
  overshoots by at most `REFUND_OVER_RATIO` (10%) of it (a rounded-up reimbursement) — bounded so a
  paycheck's "Link as a refund" doesn't list every charge. Ranked same account → closest either way (exact
  first; under beats over) → nearest date → posted before pending → id.
- **Search** (`searchRefundCharges`), above the suggestions so typing never moves it, for the charge they
  miss: every charge in the loaded range on shown accounts — any merchant, any age, any size (the cap
  still applies) — that `refundLinkError` accepts and has something left to refund. A case-insensitive substring of the
  merchant, bank text, note or dollar amount (`$800.50`, `30.00`); newest first, eight shown with
  "Showing 8 of N". While you type, its results replace the suggestions; Escape clears it first, then
  closes the detail.
- **A refund across charges** (`refundParts`, exclusive with `refundOfId`): from a linked refund's
  **Split it across another charge…** (or a suggested set), up to `FINANCE_REFUND_MAX_PARTS` (8)
  `{chargeId, cents}`, each a valid link (`refundLinkError`) and at most what's left of its charge, summing
  to at most the refund (`refundPartsError`, both impls; `refundPartsFrom` loads an older charge). The rest
  stays money in. Stored largest first; the largest is the refund's primary link (`linksOf`), so code that
  reads one link still gets one. Each charge nets by its part; the cap runs over every allocation from every
  refund (`resolveRefundClaims` → `capRefunds`). Each charge has its own **Unlink**, plus **Unlink all**;
  **Link** (one charge), a sort, a period pin or a mark clears the parts.
- **Set suggestions** (`suggestRefundSets`): when no single charge fits exactly, up to `REFUND_SET_SHOWN`
  (3) sets of 2–3 charges, drawn from the `REFUND_SET_POOL` (12) nearest in date, whose sum the refund
  matches or exceeds by at most 10% — one merchant across the set first. **Link all N** links them in one
  click.
- Sorting or moving a linked refund yourself unlinks it. A link whose charge is gone, hidden or out of the
  loaded range reads as unlinked. Two refunds on one charge are fine; the cap applies across them.
- A row in either list keeps the merchant (on a same-merchant suggestion, the bucket) on one line and puts the
  bucket and "$X already refunded" on an xs line under it, so a phone cuts neither. After an **Unlink** or **Unmark** that
  leaves nothing else to focus (a card credit with no suggestions), focus goes to the Bucket group's checked
  option — never the search box, which would raise the iPhone keyboard. The detail opens on the Bucket group
  when it has one; otherwise (linked, money in, a payment) on the dialog itself, so a stray Enter can't Unlink
  or mark. After a Link, Unlink or mark, focus moves to the button that replaced the one pressed, even while
  that button is busy: busy is `aria-disabled`, never `disabled`. Every app field is 16px or more
  (`app/src/styles/fieldSize.test.ts` scans for one that isn't); the dev check proves the finance rows against
  the fixture bank (`docs/ops/DEV-CHECK.md` → _One-time setup_ 3).

## 5. Rules

"Always put _pattern_ in _bucket_": a case-insensitive substring of the merchant; the longest active
pattern wins (`applyRules`, also matched against the digit-stripped `merchantKey`). New rows get rules at
sync time. Ticking **Always** while sorting saves the rule and sorts every currently-unsorted match (skipping
linked refunds and period marks). A rule never re-sorts a charge you sorted by hand. A rule can target Not
spending ("always that transfer"); retargeting a rule doesn't re-sort rows it already sorted.

**Split rules** ("Sort into" → **Split by percent…**): `split` holds 2–`FINANCE_RULE_SPLIT_MAX_PARTS` (4)
distinct buckets with whole percents summing to 100 (`financeRuleSplitError`). A new matching charge arrives
split by those percents (`splitFromRule`, parts carry `percent` so they recompute at a new amount); a
matching card credit takes the rule's `bucket`, its largest part (`ruleSplitBucket`). An upsert that omits
`split` keeps the stored one while the bucket is unchanged (`financeRuleFields`), so **Pause**/**Resume** and an
older cached client never wipe it; picking one bucket on the rule's row clears it, and **Always** saves a
one-bucket rule.

## 6. Sync

One Lambda, `aperture-finance-sync-<stage>` (`lambdas/src/financeSync.ts` → `finance/sync.ts`), invoked
async by the BFF after a sync request (Refresh, or the popup's Try again), connect or reconnect, and by
EventBridge Scheduler three times a day (the cron and its time zone: `cdk/src/lib/finance-sync.ts`). Items run in parallel under one deadline. Per item:

1. **Lock:** a CAS on the item's sync-state row; the `lockedUntil` value is the owner token, checked on
   every renew and at finish. A run that finds it held exits; its request stays stamped.
2. **Accounts and item health** first (`/accounts/get`, `/item/get`), so a transaction never names an
   account the table lacks.
3. **Refresh**, only when one is due from stored state (`refreshRequestedAt > lastRefreshedAt`), claimed
   in the lock CAS so whichever run holds the lock does it — once. Completion is Plaid's own
   `last_successful_update` moving, not "new rows arrived". A claim whose call never went out is restored.
4. **Pages:** gather every `/transactions/sync` page from the saved cursor, reconcile them together, write,
   and only then save the cursor — a failure anywhere replays safely. A mid-pagination mutation restarts
   from the saved cursor (up to 3 times).
5. **Writes never clobber you:** existing rows are CAS-merged with the fresh row's user fields
   (`USER_TXN_FIELDS`: bucket, override, note, refund link, mark); new rows are inserted only if absent.
   User fields carry from a pending row to its posted replacement.
6. **Finish:** one CAS that either reruns (a request landed mid-pass, up to `MAX_PASSES` 3) or stamps the
   result and unlocks — so a request can't slip between the check and the unlock.

Right after a link, a not-ready Plaid is polled until history arrives; never ready ends as
`PRODUCT_NOT_READY` rather than "synced with nothing".

**Timing budget** (the one home for these numbers):

- Lambda timeout 300 s − `RUN_SAFETY_MS` 10 s = the 290 s deadline, capped at `RUN_BUDGET_MS` 290 s, under
  the 300 s lock.
- One Plaid call's worst case `PLAID_CALL_MAX_MS` = 3 × 10 s + backoff = 31.5 s → `STEP_MAX_MS` 35 s; no
  step starts unless it can finish by the deadline (else `TIMEOUT`). `PASS_RESERVE_MS` = 70 s.
- Claiming a refresh needs 160 s of room, so the confirm poll gets ~150 s and **the timeout must stay ≥
  ~180 s** or no refresh is ever claimed.
- The page's "syncing" caps at `FINANCE_SYNCING_MAX_MS` (9 min). Refresh cooldown 5 min.
- Lambda never retries an async invoke (retryAttempts 0, maxEventAge 60 s): a failed run is already
  stamped, and a retry could re-spend a refresh.

**Tried and dropped:** a `refresh` flag on the event (a scheduled run holding the lock dropped it);
polling for "rows > 0" after a refresh (a quiet day polled the full window, and two banks overran the
Lambda); items in series; the popup deciding on `lastSyncedAt` changing (it's a min across banks);
trusting stub-only tests for async sync UX (the stub syncs inline, so `syncing` is never observed).

## 7. Sync-status contract

The stamps live on each item's `fin#sync#` row. The page reads them as `overview.sync.items[]`
(`lastSyncedAt`, `lastError`, `lastErrorAt`) plus the server-computed `sync.syncing` — its "Syncing…",
error banners and failure popup depend on nothing else:

- **`lastSyncedAt` / `lastSyncErrorAt` are the START time of the pass that set them.** A request stamped
  mid-pass stays newer, so the page keeps polling until the rerun.
- **`syncing` = `syncRequestedAt > max(lastSyncedAt, lastSyncErrorAt)`**, capped at 9 min.
- A success clears both error fields; a failure sets both.
- **Exception:** a request the run had to leave unserved (`MAX_PASSES` reached, or no time left) is
  covered, never dropped — a success stamps `SYNC_DEFERRED` at that request's time, a failure stamps
  `max(pass start, request)`. Logged as `finance_sync_request_deferred`.
- Connect and reconnect stamp `syncRequestedAt` before invoking, so the page can't decide before the run.
- `login_required` keeps failing with `ITEM_LOGIN_REQUIRED` until update mode fixes it.
- The **popup** arms on something you did (Refresh, connect, reconnect) and decides on the first newer
  overview that isn't syncing; a scheduled failure shows only the banner. Codes become words in
  `financeSyncErrorMessage`.

## 8. The Plaid seam

- Every Plaid call goes through the gated `PlaidGateway`: `createLivePlaid` (Lambda entrypoints only),
  `InMemoryPlaid` (tests, replaying `financeFixtures`), `noopPlaid` (testMode, the CI smoke run, and the
  MCP edge). Starting the sync goes through `FinanceSyncInvoker` the same way (`liveInvoker` /
  `inlineInvoker` / `noopInvoker`), and every table write through the repo's `Writes` (no-op under
  testMode).
- **Raw fetch, no SDK:** `Plaid-Version: 2020-09-14`, 10 s timeout, 3 attempts on five retryable codes,
  network retries on reads only, `/transactions/refresh` never re-sent (2/min per item). Logs carry path,
  item, Plaid `request_id` and code — never a body or token.
- **Link:** `transactions` only, `days_requested: 730` (can't be raised after linking), no `redirect_uri`
  (desktop OAuth is a popup). Update mode (reconnect, add accounts) uses `account_selection_enabled` and
  re-reads accounts. In an installed PWA, Connect opens `/finances?link=connect` in a Safari tab instead —
  Plaid Link breaks in a standalone PWA.
- **Duplicates:** Plaid doesn't block a second link of the same login, and every exchange spends a Trial
  slot forever. `isDuplicateItem` refuses before the exchange: same institution and every ticked account
  already present (name + mask), or a same-bank item whose accounts haven't synced yet.
- Row ids are Plaid's (`transaction_id`, `account_id`, `item_id`), not ULIDs. A re-link issues new ids, so
  old sorting doesn't carry over.
- Removing a bank revokes it at Plaid first, then tombstones sync state → item → accounts (in that order,
  so a sync running meanwhile buries any account it re-wrote). The Remove confirm starts on **Cancel** —
  deliberately unlike other confirms — because it's irreversible and the slot is spent.
- **CSP (not set today):** if the app ever gets one, Link needs `script-src https://cdn.plaid.com/link/v2/stable/link-initialize.js 'unsafe-inline' blob:`,
  `frame-src https://cdn.plaid.com/`, `style-src 'unsafe-inline'`, and `connect-src` for the Plaid host.

## 9. Stub hooks

The stub (`app/src/data/stubClient.ts`, environment `stub`) replaces Link with `FakeLinkDialog` and syncs
the fixtures inline. `localStorage["aperture:stub:failNextFinanceSync"] = "<PLAID_ERROR_CODE>"` makes the
next sync fail with that code; `ITEM_LOGIN_REQUIRED` keeps failing until reconnect, like Plaid. Known
divergences: the stub syncs inline, so the page never sees `syncing: true` (tests that need it hold the
overview in a mocked client), and a re-link reuses the fixture ids.

## 10. Plaid facts we rely on

Verified 2026-09-24/26 against Plaid's docs and a Production `/institutions/get_by_id`.

- **Trial:** 10 Production Items, `/item/remove` doesn't free one, no time limit, never auto-converts;
  compliance registration waived until upgrade. The account can be deactivated after 3 months unused —
  the schedule keeps it active. Production approved 2026-09-26.
- Only Sandbox and Production exist (dev → Sandbox, prod → Production). Sandbox logins: `user_good` /
  `pass_good`, `user_transactions_dynamic`; OAuth test bank Platypus `ins_127287`.
- `/transactions/sync` reads Plaid's cache (Plaid pulls the bank 1–4×/day); `/transactions/refresh` asks
  for a pull. `amount` is positive for money out.
- **Pending → posted:** the pending id arrives in `removed`; the posted row arrives with a new id and
  `pending_transaction_id`.
- **The linked bank:** OAuth. It hosts its own account picker — tick every account (checking, savings, card). Deposit history ~18 months; card = current cycle + 11 previous. Consent lasts 12 months;
  `PENDING_DISCONNECT` a week before, then `ITEM_LOGIN_REQUIRED` → reconnect.
- **Seen on the first real sync (2026-09-28):** a card payment arrives as a pair whose descriptors
  share one confirmation code — card side money in (category `TRANSFER_IN_ACCOUNT_TRANSFER`), checking
  side money out (`LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`). Purchases are positive on the card, refunds negative, and the card's
  `current` balance is what's owed — no flip needed. The bank **does** send pending rows. Still unmeasured:
  refresh latency and how long NOT_READY lasts after linking. (Sandbox's canned "AUTOMATIC PAYMENT" is
  money out on the card — Sandbox data, not that bank's shape.) Consequence (inferred, not yet seen): only the
  checking side carries the card-payment category, so a card side that can't pair — checking hidden or
  unlinked, or the two posted more than 3 days apart — reads as a **refund** and lands in Sort. Mark it as
  the period start, or teach the payment hint `TRANSFER_IN_ACCOUNT_TRANSFER` on a credit account.
- **Why Plaid:** Teller announced it was withdrawing its API (2026-07); SimpleFIN Bridge costs money,
  allows ~24 requests a day with no on-demand refresh, and carries no categories. Plaid Trial is $0 with
  real production data, refresh and categories.

## 11. Dependencies

- **`@aws-sdk/client-lambda`** (3.1102.0) — rule B: the BFF starts the sync Lambda with a SigV4-signed
  async Invoke, which we won't hand-roll. It ships in the Node 22 runtime, so the bundle keeps it external,
  pinned to the same line as the other AWS clients.
- **Rejected `plaid`** (the Node SDK, v47: ~18 MB unpacked plus axios) for a handful of POSTs —
  `lambdas/src/plaid/livePlaid.ts` is raw fetch.
- **Rejected `react-plaid-link`** (a script loader plus a `Plaid.create` wrapper, pulls `prop-types`, and
  has an open installed-PWA bug, https://github.com/plaid/react-plaid-link/issues/396) —
  `app/src/modules/finances/usePlaidLink.ts` does the same in a few dozen
  lines.

## 12. Operator checklist

- **SSM (SecureString, us-west-1), written once per stage by you:** `/aperture/<stage>/plaid/client_id`
  and `/aperture/<stage>/plaid/secret` (dev = the Sandbox secret, prod = Production). Put them with
  `read -rs` so values stay out of history; `--overwrite` to rotate (warm Lambdas keep the old value until
  they recycle). Missing → Connect says "Plaid credentials not configured".
- **`/aperture/<stage>/plaid/items/<itemId>/access_token`** is written and deleted by the BFF, read by the
  sync. Never delete one by hand — without it the bank can't be removed at Plaid.
- **Dev lives in its own AWS account** since the dev-account PR (INFRA §2): its `client_id`/`secret` were
  copied across once; its Sandbox items were not — relink on dev.
- **The schedule is gated on `DEVICE_USER_ID_<STAGE>`** (the same GitHub secret the LeetCode ingest uses):
  unset means no scheduled sync (devb, a local synth — dev and prod CI refuse to deploy without it); wrong means it syncs an empty partition. See
  [recruiting/](../recruiting/index.md) → Operator setup.
- **Linking:** from a Safari tab. Tick every account in the bank's picker; add a missed one later with the
  bank's **⋯ → Add or remove accounts** (update mode), never a second Connect.
- **First-sync sign check:** a known card purchase is an expense (money out), the card payment shows as a
  pair (card side money in, checking side money out), a known refund is money in, and the card balance is
  what you owe. If the card reads inverted, flip it in the accounts strip.
- **Disabling, least to most:**
  1. Flip a mis-signed account.
  2. Disable the schedule: `aws scheduler update-schedule --region us-west-1 --group-name
aperture-finance-<stage> --name aperture-finance-sync-<stage> --state DISABLED --schedule-expression 'cron(15 5,15,20 * * ? *)'
--schedule-expression-timezone America/Los_Angeles --flexible-time-window Mode=OFF --target
'<Target JSON from get-schedule>'`. This drifts from CloudFormation — a later deploy that touches the
     schedule may re-enable it.
  3. Delete the two credential parameters (warm Lambdas keep the cached ones until they recycle).
  4. Remove the bank in the app — revokes at Plaid, deletes the token, tombstones the rows; the slot stays
     spent.
  5. Revert the PR — remove the bank first, since the revert removes the code that calls `/item/remove`.
     The `fin#` rows (RETAIN table) and the SSM credentials stay. Reverting past Not spending: first set
     every Not-spending row back to Unsorted and delete or retarget Not-spending rules — older code throws on
     the unknown bucket and the overview 500s. Reverting past splits throws nothing server-side: older code
     ignores `splits`, `refundParts` and a rule's `split`, so a split charge reads Unsorted, a refund across
     charges reads unlinked (a deposit as income, a card credit as an unsorted refund), and a split rule
     sorts into its largest part. Older writes keep the fields on the row they write (a pending row that
     posts drops them). On a re-deploy the server drops a stale field as it reads the row (`toFinanceTxn`,
     `toFinanceRule` → `normalizeFinanceTxn`, `normalizeFinanceRule`): a split beside a bucket, a mark or an
     empty `bucketSetBy` (so an older unsort, unmark or unlink doesn't bring it back); refund parts beside a
     single link, a bucket, a pin, a mark or an empty `bucketSetBy` (every newer allocation stores `'user'`); a rule split whose bucket isn't its largest part. The next write
     of that row stores the cleared field; reading alone writes nothing. The client applies the same checks
     (`liveSplits`, `liveRefundParts`, `ruleSplitOf`), so a still-cached new PWA against a reverted BFF reads
     a stale or missing field as none. Its edits that need the new server are refused, loudly, with nothing stored, until its next launch:
     a split or an allocation save is an unknown method, and adding a rule or changing a rule's bucket on the Rules
     tab carries a `split` key the older server refuses (Pause, and Always from a row, still work). Undo cases not caught (§14): an older pin then unpin of a refund across
     charges (an older pin writes only the pin), and an older retarget of a split rule away and back to its
     largest part — each brings the old field back. For a clean revert, remove the
     splits, the multi-links and the split rules first.

## 13. What each test surface proves

- **Shared contract suite** (`packages/shared/src/contractTests.ts`) runs against the stub, the Lambda
  backend directly, and through `handleRpc` — the finance cases prove stub/Lambda parity.
- **`lambdas/src/finance/sync.test.ts`**: the lock, reruns, deadlines, refresh claims, SYNC_DEFERRED and
  removal races, over `InMemoryDoc` hooks (stale reads, interleaved writes).
- **cdk `stacks.test.ts`**: the sync function's shape, IAM (the sync role gets GetItem/PutItem/Query and
  Plaid read only; the BFF invokes exactly that function; the MCP role gets nothing Plaid), the schedule
  and the alarms.
- **MCP** (`lambdas/src/mcp/financeTools.test.ts`, `index.test.ts`): the read-only tools match the page
  and never reach Plaid. See [mcp/](../mcp/index.md).
- **Splits and refunds across charges:** `financeSplits.test.ts` (the pure decisions),
  `financeSplitContract.ts` (stub/Lambda parity, from the contract suite), `FinanceSplits.test.tsx` (the
  editors), and the `finance-splits` dev-check scenario on the fixture bank.

| Where                                                                   | What                                     |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| `packages/shared/src/finance.ts`, `financeFixtures.ts`, `plaidTypes.ts` | types, the pure logic, fixtures          |
| `app/src/pages/Finances/`, `app/src/modules/finances/`                  | the page, tabs, detail, sync watch, Link |
| `app/src/data/stubClient.ts`, `app/src/data/hooks/useFinances.ts`       | the stub; queries + mutations            |
| `lambdas/src/finance/` (`service.ts`, `sync.ts`, invokers)              | the RPC methods and the sync             |
| `lambdas/src/financeSync.ts`                                            | the sync Lambda's entry                  |
| `lambdas/src/plaid/` (`gateway.ts`, `livePlaid.ts`)                     | the Plaid seam                           |
| `lambdas/src/mcp/financeTools.ts`                                       | the read-only MCP tools                  |
| `cdk/src/lib/finance-sync.ts`, `app-stack.ts`, `monitoring.ts`          | the function, schedule, IAM, alarms      |

## 14. Known limits and deferred

- **Deferred:** moving a whole unsplit charge to next period (today only a split's part can wait).
- **Accepted (splits):** two allocations onto one charge saved seconds apart can both pass the "left" check
  (the other refunds are read off the eventually consistent index); the cap still keeps the charge at or
  above $0, so the cost is an over-allocation stored, not a wrong total. A split rule decides money out by
  Plaid's raw sign, so on a flipped account it splits card credits instead (they then read as broken
  splits, in Sort). A sync already running on old code during a deploy (up to 300 s) writes its
  pass-start copy of the new fields under the fresh row's own, on any row it writes in that window: it can
  drop a split saved then, put an edited split's earlier parts back, or bring back an allocation unlinked
  then (a Remove split or a sort in the window is caught by the read checks). Merging away from the
  scheduled sync times keeps the window empty.
- **Accepted (revert undo cases):** after a revert and re-land, an older pin then unpin of a refund across
  charges (an older pin writes only the pin, so `bucketSetBy` survives it), or a split rule retargeted away
  and back to its largest part, brings the old allocation or split back; the clean-revert step in §12
  avoids it. An older link, sort or mark nulls `bucketSetBy`, so its undo can't.

- **Accepted:** a late BFF invoke after a deferred request can show a "try again" the data didn't need;
  `SYNC_DEFERRED` after a pass that did land data shows as a red banner; **Always** scans every
  transaction row (fine at one user); cdk-nag acks match by id app-wide. The All tab's "N rows · $X" is
  the raw net of the rows shown, so a capped refund's overshoot shows there (the row's "counts $X"
  explains it) though no bucket total includes it. A refund overshooting a charge by more than 10% isn't
  suggested; linking it takes the link panel's search (§4). A transfer-tagged deposit is refused as a
  refund only when it pairs as a move; its other half dated just before the 120-day lookback can't pair,
  so such a deposit can be linked — a wrong link is one Unlink away.
- **Deferred (v2):**
  - A fuzzier merchant match ("AMZN Mktp" vs "AMAZON MKTPL").
  - CSV import (`source` is reserved for it).
  - Finance writes over MCP (today read-only).
  - Hidden-account polish.
