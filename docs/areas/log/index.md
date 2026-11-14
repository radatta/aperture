# Log — private entries

The interstitial log (`/log`, capture's Log mode) is append-only text, one day per page. This doc records **private entries** (2026-11, branch `private-log`): the user can mark a line private, which keeps it away from Claude once log entries reach the MCP tools.

## What "private" means

- `LogEntry.private?: boolean` (`packages/shared/src/types.ts`). Rows written before the field read back `undefined` = public. The attribute rides the `log#<day>#<id>` item through `entityItem`'s spread, so there's no repo or key change.
- **In the app, a private entry reads normally.** It shows a lock on its `/log` row and a small lock glyph in Home's night "Today in review". Nothing is hidden from the user, and the export (`exportData`, the user's own download) keeps the text and the flag.
- **Over MCP, the text never leaves** (`lambdas/src/mcp/logTools.ts`, [mcp](../mcp/index.md)). Every MCP log read shows the text as `🔒 private entry`, keeping the day and time, and search never matches against private text: a redacted _hit_ would still confirm what the query matched. Both happen at the log tools' single choke point. No MCP tool sets or clears the flag; it's an app-only control.
- This is a reach control, not encryption. The text sits in DynamoDB like any other entry.

## Setting it

| Where                 | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/log` row            | an always-visible lock button (`aria-pressed`, label "Private entry", described by the row's text; the lock is filled when private). One tap toggles it, on any entry, old or new. `setLogEntryPrivate(id, isPrivate)` is optimistic; a failure rolls back that row with a visible error line (cleared on a day change). Edits and toggles share one mutation scope (each puts the whole entry, so two in flight could undo each other), and the day refreshes only after the last queued write settles. An unsaved optimistic row's lock is disabled. |
| Capture bar, Log mode | a `private` pill after the mode toggle, **one-shot** like `→ today`: it applies to the next entry, then resets, so it can never quietly keep hiding entries. A mode change drops it. A failed save restores the text with the pill still on, and a parked capture puts back private (`Parked.isPrivate`). The receipt reads "Logged privately".                                                                                                                                                                                                        |
| API                   | `createLogEntry(text, day, { private })`. `updateLogEntry` keeps the flag. `setLogEntryPrivate(id, isPrivate)` sets it. `createLogEntry` and `setLogEntryPrivate` refuse a non-boolean flag, and an unknown, tombstoned or other user's id gets `Not found`.                                                                                                                                                                                                                                                                                           |

## The "Make private?" nudge

`app/src/modules/log/sensitive.ts` is local and pure (no API, no model). A listed term counts only when no letter touches it on either side. That's why `pw:`, `pin 4821` and `password=` fire, while keyboard, pinned, leetcode, passed and pwned don't. The terms are password/passphrase/passcode/passwd, pw, `pwd:`, PIN(s) followed by a digit, `:`, `#` or "code/number/is", a bare code followed by 6+ digits, qualified codes (verification, backup, garage, 2FA…), otp/2fa, qualified keys (api, ssh, license, recovery…), service tokens (api, github, npm, slack…; `_` joins too, as in `API_KEY=`), `token:`, `secret:`, credentials/creds, `login:`, ssn, cvv/cvc, passport number, card/routing/account number, IBAN, and seed/recovery phrase. Review round 1 dropped credit card, auth code, mnemonic, mfa and access/refresh tokens as everyday words for this user. Bare _code_, _key_, _pin_, _secret_ and _token_ are left out on purpose: they're everyday words. The full positive/negative table is in `sensitive.test.ts`.

In Log mode, with the pill off, a matching draft shows a gold row under the field: "Looks sensitive — make it private?", with **Make private** and **×** ("Not this one").

- **Make private** arms the pill and doesn't save, because it can be tapped mid-sentence.
- **×** dismisses the nudge for this draft. Edits don't bring it back, and an emptied field starts a new draft. Nothing is stored and there's no setting.
- **The first Enter on a sensitive draft is held once.** The row then reads "Enter again saves it as is" and the receipt "Not saved yet". The second Enter saves the entry public. This is because type-then-Enter leaves no time to tap the row. A false positive costs one extra Enter.
- The app never marks anything private on its own.

## Decisions

Logged in the branch's `localNotes/decisions.md`; the ones that shape behaviour:

- One-shot pill, not sticky (above).
- Hold the first Enter once per draft (above). To undo it, delete the `nudge.held` branch in `CaptureBar.submit()`.
- Field name `private` on the entity and JSON (the user's word). Identifiers use `isPrivate`, because `private` is reserved in strict mode and must never be destructured.
- Not now: the nudge in Task/Idea modes or on Inbox's "To log", and a persisted "never ask" dismissal. These are follow-ups if daily use asks for them.

## Dev check

`scripts/src/devcheck/scenarios/private-log.ts` encodes the matrix: the pill, the nudge, the row lock (including a failed toggle, injected with `ctx.intercept`), the night glyph, a 390 light/dark pass, the API flag, and MCP redaction. Entries are tagged with the run's nonce with its letters dropped, so a nonce can't spell a sensitive term. They're ledgered by id and tombstoned through `deleteLogEntry`.
