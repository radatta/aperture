# Finances — the three-bucket budget over Plaid

`/finances`: every charge on the Bank of America card and accounts, sorted into **Parents pay · Budget ·
I pay**, against a **$600 budget per billing period**. A port of penny-pilot's budget, synced through
**Plaid Trial** ($0). This doc is the design record and the one home for the sync-status contract, the
Plaid facts we rely on, and the operator checklist. Built on `feature/finances-page`, 2026-09.

## 1. Shape

- **Page:** `/finances` with tabs **Sort** (the batch queue), **All** (the ledger of the current and
  previous period) and **Rules** — real routes, like Recruiting. It's an AppNav link, not a dock item (one
  dock, [CONVENTIONS](../../product/CONVENTIONS.md)).
- **Home:** one line, never a card — Morning is at its ≤5-element cap. Morning: "$X left of $600 · N to
  sort"; Night: "N charges to sort", only when non-zero (`pages/Home/FinanceGlance.tsx`). Nothing until a
  bank is connected.
- **Settings:** budget per period (default $600) and card payment day (default 20).
- **Header:** left of the budget, the period and its day, and a nudge to mark the last card payment when
  the period is on the payment-day fallback.

## 2. Buckets and money

- Buckets `parents_pay` / `budget` / `i_pay` (keys **1 / 2 / 3** on a focused Sort group). Only **Budget**
  counts against the budget; the other two are tracked, not limited.
- **Sign:** `rawAmountCents` stores Plaid's number, **positive = money out**. Normalisation is read-time:
  `amountOf` applies the account's `signOverride` (`flip`), so flipping an account changes nothing stored.
- **Kinds** (`classifyTransaction`): `expense` (a charge), `refund` (money into a card), `income` (money
  into checking/savings), `transfer` (between your own accounts), `card_payment`. Only expenses and
  refunds are sortable; a deposit counts only once linked as a refund.
- **Internal moves** (`detectInternalMoves`) pair a depository outflow with an equal inflow on another of
  your accounts within `PAYMENT_MATCH_WINDOW_DAYS` (3), nearest date first, needing a transfer/loan-payment
  Plaid category (or a period mark) on one side.
- **Hidden accounts** are listed but excluded from every total, the sort queue and refund links. A hidden
  card's period marks still count.

## 3. Periods and marks

- **You mark the card payment that ends a period** (money in on a credit account); the next period starts
  the day after it. `periodStartError` is re-checked at read time, so a flipped or moved row stops
  anchoring the period.
- With no valid mark in the 120-day lookback (`FINANCE_OVERVIEW_LOOKBACK_DAYS`), the period falls back to
  the day after `financePaymentDay`. Detection only **suggests** a mark (`suggestPeriodStart`, the header
  nudge) — it never moves the period on its own.
- Marking today's payment leaves an empty current period that starts tomorrow.
- A row can be pinned to **This period** or **Last period** (`periodOverride`), overriding its date.

## 4. Refunds

- A refund (card credit, or a checking/savings deposit) is linked to the charge it reverses; it then takes
  the charge's bucket and period, nets against it, and leaves the sort queue. An unlinked deposit is
  income, outside the budget.
- `refundLinkError` (shared by the suggestions and the server, so the page never offers a link the server
  refuses): both sides on shown accounts, no payment or transfer, the refund no larger than the charge, and
  the charge dated no more than `REFUND_DATE_SLACK_DAYS` (3) after the refund.
- Suggestions (`suggestRefundMatches`) look back `REFUND_MATCH_WINDOW_DAYS` (90): same-merchant charges
  first, otherwise any merchant, top five; ranking is in the function.
- Sorting or moving a linked refund yourself unlinks it. A link whose charge is gone, hidden or out of the
  loaded range reads as unlinked. Over-refunding one charge via two refunds isn't blocked (accepted).

## 5. Rules

"Always put *pattern* in *bucket*": a case-insensitive substring of the merchant; the longest active
pattern wins (`applyRules`, also matched against the digit-stripped `merchantKey`). New rows get rules at
sync time. Ticking **Always** while sorting saves the rule and sorts every currently-unsorted match. A rule
never re-sorts a charge you sorted by hand.

## 6. Sync

One Lambda, `aperture-finance-sync-<stage>` (`lambdas/src/financeSync.ts` → `finance/sync.ts`), invoked
async by the BFF after Refresh / connect / reconnect and by EventBridge Scheduler at **5:15a, 3:15p and
8:15p Pacific**. Items run in parallel under one deadline. Per item:

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

**Timing** (the one home for these numbers):
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
Lambda); items in series; the popup deciding on `lastSyncedAt` changing (it's a min across banks).

## 7. Sync-status contract

The page's "Syncing…", error banners and the failure popup read only these stamps (per item, in
`overview.sync.items`; the overview's own fields summarise them):

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
  `inlineInvoker` / `noopInvoker`).
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
- **Bank of America:** `ins_127989`, OAuth. BofA hosts its own account picker — tick checking, savings
  and the card. Deposit history ~18 months; card = current cycle + 11 previous. Consent lasts 12 months;
  `PENDING_DISCONNECT` a week before, then `ITEM_LOGIN_REQUIRED` → reconnect.
- **Unverified until the first real sync:** the card-payment sign (Plaid's docs disagree), whether BofA
  sends pending rows, the checking-side payment descriptor, refresh latency, and how long NOT_READY lasts
  after linking.
- **Why Plaid:** Teller announced it was withdrawing its API (2026-07); SimpleFIN Bridge costs money,
  allows ~24 requests a day with no on-demand refresh, and carries no categories. Plaid Trial is $0 with
  real production data, refresh and categories.

## 11. Dependencies

- **`@aws-sdk/client-lambda`** (3.1102.0) — rule B: the BFF starts the sync Lambda with a SigV4-signed
  async Invoke, which we won't hand-roll. It ships in the Node 22 runtime, so the bundle keeps it external,
  pinned to the same line as the other AWS clients.
- **Rejected `plaid`** (the Node SDK: ~18 MB unpacked plus axios) for a handful of POSTs —
  `lambdas/src/plaid/livePlaid.ts` is raw fetch.
- **Rejected `react-plaid-link`** (a script loader plus a `Plaid.create` wrapper, pulls `prop-types`, and
  has an open installed-PWA bug) — `app/src/modules/finances/usePlaidLink.ts` does the same in a few dozen
  lines.

## 12. Operator checklist

- **SSM (SecureString, us-west-1), written once per stage by you:** `/aperture/<stage>/plaid/client_id`
  and `/aperture/<stage>/plaid/secret` (dev = the Sandbox secret, prod = Production). Put them with
  `read -rs` so values stay out of history; `--overwrite` to rotate (warm Lambdas keep the old value until
  they recycle). Missing → Connect says "Plaid credentials not configured".
- **`/aperture/<stage>/plaid/items/<itemId>/access_token`** is written and deleted by the BFF, read by the
  sync. Never delete one by hand — without it the bank can't be removed at Plaid.
- **The schedule is gated on `DEVICE_USER_ID_<STAGE>`** (the same GitHub var the LeetCode ingest uses):
  unset means no scheduled sync; wrong means it syncs an empty partition. See
  [recruiting/](../recruiting/index.md) → Operator setup.
- **Linking:** from a Safari tab. Tick every account in BofA's picker; add a missed one later with the
  bank's **⋯ → Add or remove accounts** (update mode), never a second Connect.
- **First-sync sign check:** a known card purchase is an expense (money out), the card payment shows as a
  pair (card side money in, checking side money out), a known refund is money in, and the card balance is
  what you owe. If the card reads inverted, flip it in the accounts strip.
- **Disabling, least to most:** flip a mis-signed account · disable the schedule · delete the two
  credential parameters · remove the bank in the app (revokes at Plaid; the slot stays spent) · revert the
  PR (remove the bank first — the revert removes the code that calls `/item/remove`).

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

## 14. Known limits and deferred

- **Accepted:** a late BFF invoke after a deferred request can show a "try again" the data didn't need;
  `SYNC_DEFERRED` after a pass that did land data shows as a red banner; **Always** scans every
  transaction row (fine at one user); cdk-nag acks match by id app-wide.
- **Deferred (v2):**
  - "Show other charges" when linking a refund — today a same-merchant match hides other merchants and
    anything past the top five (tracked as a prod Aperture task).
  - A fuzzier merchant match ("AMZN Mktp" vs "AMAZON MKTPL").
  - CSV import (`source` is reserved for it).
  - Finance writes over MCP (today read-only).
  - The top nav clips "Finances" at 390 px.
