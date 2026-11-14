# Public content — what GitHub-bound text may say

The repo is public. Everything that reaches GitHub passes this one gate: code, docs, tests, fixtures, comments, commit messages, PR titles and bodies, and report text pasted into a PR. Hard identifiers (name, mailbox, paths, account ids) and their regex guard live in [IDENTIFIERS.md](IDENTIFIERS.md); this doc is the judgment half. The `code-reviewer` agent screens every diff against it, and the author scans the PR title, body and report before `open-pr`.

## Never

| Category                          | Look for                                                                  | Bad (synthetic)                                    | Good                                                      |
| --------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Life stage or bio, first person   | school or year, job or internship plans, personal stress, self-assessment | "I'm a <year> student and always under-scope"      | "for someone who under-scopes"                            |
| Real money                        | amounts, balances, budget numbers, account or card digits, store numbers  | "<bill> <amount> from the account ending <digits>" | "a fixed monthly bill"; fixtures: `12.34`, mask `0000`    |
| School identifiers                | course codes, term calendar, LMS name, professors                         | "the <course code> problem set, due on <LMS>"      | "a problem set"; `School` as the area                     |
| Family, roommates, relationships  | who pays, who lives where, who someone is to the maintainer               | "my <relation>'s half of the bill"                 | "a shared bill"                                           |
| Verbatim quotes of the maintainer | quote marks beside an attribution; first-person fragments                 | an attribution and date, then a quoted sentence    | paraphrase, keep the date: `(the maintainer, YYYY-MM-DD)` |
| Home path, projects folder        | see IDENTIFIERS.md                                                        | —                                                  | `<mac-repo>`, `~/<other-project>`                         |
| Real people's names               | anyone not a cited author or public figure                                | "asked a named friend to test it"                  | "a tester"; fixtures: `Alex Example`                      |

## Write it this way

- **Product voice, not first person.** Describe who a feature is for, not who asked.
- **Paraphrase, not quotes.** A decision keeps its date and its reason, not its wording.
- **Obviously synthetic fixtures.** The Plaid sandbox bank, round or patterned amounts, generic stores ("Grocery Store"), `example.com` addresses. A value that could be real reads as real.

## Fine as is (decided 2026-11-14 — don't scrub, don't flag)

Device names, models and viewport sizes · Flux's exercise framing and wording · the finances doc's Plaid and bank technical notes (account types, history depth, dates) · exact timestamps in incident and handoff docs · the identifiers in `identifiers.json` (name, the Gmail as contact and alerts, domain) · the `parents_pay` stored key · `School` and `Recruiting` as area names · the AWS ids as IDENTIFIERS.md places them.

## A finding

`path:line — <category> — <what to write instead>`. Never repeat the offending text: findings get pasted into reports and PRs. A commit message or PR body is cited as `commit <sha7> subject` or `localNotes/pr-<branch>.md:line`. A Never hit in a commit message needs the commit reworded before the push, since a branch's history is public on its PR: `git commit --amend -m …` for the last commit; an older one needs a rebase, then `pnpm bot push --after-rebase` (IDENTIFIERS.md → the push recipe). Lines the diff didn't add are out of scope; at most one "pre-existing" note.

## What enforces it

The regex guard (IDENTIFIERS.md → _The checks_) blocks only the hard identifiers. Course-code, card-digit and dated-quote shapes were measured on 2026-11-14 and left to review: the first two match HTTP, RFC, ISO and test tokens far more often than real values, and the quote shape catches one form of many. A session that skips the reviewer skips this screen, so phase 10's scan of the PR body and report is the author's own check.
