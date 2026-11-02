# Mac mailroom — Claude opens PRs as the user

The last manual step before a merge was the user running `gh pr create` on the Mac. The bot can't take it over, because a squash commit's author is whoever opened the PR, and `main` must stay the user's (CI-BOT.md). The **mailroom** does it instead. Claude drops a job file into a folder the Mac shares with the container. A launchd agent on the Mac picks it up and opens the PR with the user's own **PR-only token**. The PR is the user's, and nobody had to touch it.

Think of a mailroom clerk. The container drops off a form. The clerk follows a fixed checklist, and the form only fills in the blanks. Built 2026-11-01 (`mac-mailroom` branch, PR 1 of mac-sim). PR 2 adds Simulator jobs on the same mailroom (_Adding a job_).

```
container (untrusted)                               Mac (trusted; nothing from the shared folder is executed)
pnpm mailroom open-pr --title T
  localNotes/pr-<branch>.md → lint → embed            launchd agent dev.rahuldatta.aperture.mailroom (Aqua)
  .hostjobs/staging/<id>.json ─rename─▶ .hostjobs/inbox/<id>.json
                                                        │ QueueDirectories (or StartInterval 15 s: --mode poll)
                                                        ▼
                                                      ~/Library/Application Support/aperture-mailroom/bin/runner.sh
                                                        (the INSTALLED copy) mv inbox/<id>.json → state/work/
                                                        jq validate → jobs/open-pr.sh (curl + jq):
                                                          token ← Keychain aperture-mailroom-gh
                                                          GET /user (= radatta)  GET …/git/ref/heads/<b> (= sha)
                                                          GET …/pulls?head=radatta:<b>&state=open  POST …/pulls
  polls results/<id>/result.json (2 s, ≤ 180 s) ◀──── .hostjobs/results/<id>/result.json
  prints the URL; no answer → withdraws the job, prints the hand-off command
```

`.hostjobs/` sits at the main checkout's root, so every worktree shares it. The container finds it through `git rev-parse --git-common-dir`, the same anchor as the bot's `secretsDir()`. It is gitignored.

## The token

The mailroom uses **no `gh`, no `git`, and never the user's own GitHub login**. It has its own fine-grained PAT, and that token reaches only `curl`, only `https://api.github.com`, and only the four calls above.

**Spec:** name `aperture-mailroom`; owner `radatta`; Repository access **Only select repositories → aperture**; **Pull requests: Read and write**, **Contents: Read**, and Metadata: Read (added automatically); everything else No access; expiry 1 year. To create it: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Created 2026-11-01.

**It lives only in the Mac's Keychain**, in the generic-password item `aperture-mailroom-gh`, read by `security find-generic-password -s aperture-mailroom-gh -w` inside the runner. **Never put it in a file anywhere under the repo folder.** `/workspace` _is_ the Mac's repo folder, so any file there, `.hostjobs/` and the worktrees included, is readable by the container, and a token stored there becomes the container's token. `runner-fixtures.test.ts` checks that the runner has no other token source: no environment variable, no file, nothing on argv. The token reaches `curl` as a header through a process-substituted file, the `tools/raycast` idiom.

What the docs settle (2026-11-01, [fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)):

| Question                               | Answer                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening a PR (`POST …/pulls`)          | needs Pull requests: write only                                                                                                                                                                                                                                         |
| Merging (`PUT …/pulls/{n}/merge`)      | needs **Contents: write**, which this token doesn't have, so it can't merge. The user's admin bypass is moot: the call is refused at the token layer before any ruleset is consulted.                                                                                   |
| Approving                              | possible through the API, but [a PR's author can't approve their own PR](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews), and only the user opens PRs here |
| Auto-merge                             | off in the repo settings (user confirmed 2026-11-01). Even if it were on, `main`'s ruleset wants a code-owner review that the author can't give.                                                                                                                        |
| The head-sha check (`GET …/git/ref/…`) | Contents: read                                                                                                                                                                                                                                                          |
| Expiry                                 | every response carries `GitHub-Authentication-Token-Expiration`. Expired or revoked → `401`; a permission removed → `403`/`404`.                                                                                                                                        |

**Worst case if the runner has a bug:** the token opens or edits a PR on this repo, or reads the repo. Nothing more.

**Renew yearly.** GitHub emails before the expiry. Every result carries `tokenExpiresAt`, and the CLI prints `TOKEN_EXPIRING` when fewer than 14 days are left. To renew, regenerate the token in GitHub with the same permissions, then run:

```sh
cd /Users/rahuldatta/Coding/Personal/aperture && security add-generic-password -a "$USER" -s aperture-mailroom-gh -T /usr/bin/security -U -w
```

The first add is the same command without `-U`. `-w` with no value prompts for the token, so it never lands in shell history. `-T` pre-trusts `security`, so launchd's reads don't raise a Keychain dialog.

## Install, update, remove

All on the Mac, needing only what macOS 15+ ships (`bash` 3.2, `jq`, `curl`, `security`, `launchctl`, `plutil`, `shasum`):

```sh
cd /Users/rahuldatta/Coding/Personal/aperture/.claude/worktrees/mac-mailroom && bash tools/mailroom/install.sh && launchctl print gui/$(id -u)/dev.rahuldatta.aperture.mailroom | head -20
```

`install.sh` runs from any checkout or worktree; `.hostjobs/` always goes at the main checkout. In order, it:

1. Prints a diff of the repo's `runner.sh` + `jobs/` against the installed copy.
2. Copies them, never symlinking, into `~/Library/Application Support/aperture-mailroom/bin/`, with a `VERSION` file (sha256 of `runner.sh` then `jobs/*.sh`).
3. Renders the plist into `~/Library/LaunchAgents/`.
4. Creates `.hostjobs/{staging,inbox,results}` and writes `.hostjobs/installed.json`.
5. Loads the agent with `launchctl bootout` then `bootstrap`.

The **installed copy is the trust boundary**. The container can rewrite the repo's runner, but launchd only ever runs the copy, so a change reaches the Mac only when the user re-runs `install.sh` after reading the diff. Re-run it after any `tools/mailroom/` change. The CLI warns when a result's `runnerVersion` differs from the repo's.

- `--mode poll` swaps the folder watch for a 15 s timer. Use it if QueueDirectories never fires on the shared folder (_Trial_).
- `--uninstall` removes the agent and the installed copy. It keeps `.hostjobs/` and the Keychain item: delete the item with `security delete-generic-password -s aperture-mailroom-gh` and revoke the token on GitHub.
- The log is `~/Library/Logs/aperture-mailroom/agent.log`. It holds codes, ids, durations and HTTP statuses, never the token or the body.

## Using it (container)

| Command                                                | Does                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm mailroom open-pr --title "<title>" [--wait <s>]` | Opens this pushed branch's PR from the worktree's `localNotes/pr-<branch>.md`, as the user. Exit 0 prints `opened <url>` or `exists <url>`.            |
| `pnpm mailroom probe [--wait <s>]`                     | The whole path (inbox → launchd → Keychain → GitHub) with a zero sha, so it stops at `HEAD_MISMATCH` before any write. Exit 0 prints the token expiry. |

`open-pr` works through these steps:

1. Refuses a detached HEAD, a deploy branch, or an unpushed branch (`pnpm bot push` first).
2. Lints the title and body with the runner's own rules and prints a fix-it hint on failure.
3. Skips the job if the container's read-only `gh` already sees an open PR. This check is best-effort.
4. Submits the job, waits up to 180 s, and checks that the result's `bodySha256` matches the file.

Exit codes: 1 is a refusal or failure, printing the code and the renewal line for `TOKEN_*`; 2 is a usage error.

**Exit 3 `MAC_UNREACHABLE`** means no result within 180 s. That covers a Mac asleep, the agent not installed, or the agent not firing. The job is **withdrawn** from the inbox so it can't fire later. If the Mac already took it, the CLI waits 30 s more. It then prints whether the Mac was ever installed and the age of its last result, plus the hand-off line, `cd <Mac worktree> && gh pr create --title "…" --body-file localNotes/pr-<branch>.md`. The title rule excludes `"`, `$`, backticks and `!`, so that line always pastes cleanly. In autonomous mode this is the `CC blocked` path (CLAUDE.md → _Feature workflow_).

## Job and result

The job is `inbox/<id>.json`, at most 72 KiB:

```json
{
  "v": 1,
  "id": "20261101T204512Z-mac-mailroom-3kx9",
  "job": "open-pr",
  "submittedAt": "2026-11-01T20:45:12Z",
  "expiresInMin": 20,
  "params": {
    "branch": "mac-mailroom",
    "sha": "<40 hex>",
    "title": "…",
    "body": "<markdown>",
    "bodySha256": "<hex>"
  }
}
```

- `id` is `^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}$` and must equal the file's stem.
- `job` must be on the allowlist.
- `submittedAt` is ISO with no millis. It may be at most 5 min in the future, and it expires after `expiresInMin`, which runs 1–60.
- `branch` is `^[a-z0-9][a-z0-9-]{0,62}$`, and not `main`, `master` or `dev`.
- `sha` is 40 hex.
- `title` is `^[A-Za-z0-9][A-Za-z0-9 .,:;()/+_&'-]{3,99}$`.
- `body` is 1–64 KiB, and `bodySha256` must match it.
- Repo, base (`main`) and owner are constants in the runner, never params. No extra keys are allowed at either level.

The **body travels inside the job**: the runner reads nothing from the shared folder after it moves the job out. Reading the worktree file by path would leave a check-then-read window. A looping container could swap that file for a symlink to any Mac file the user can read, and get it posted publicly. The body refuses:

- C0/C1 controls (tab and newline allowed), zero-width characters, bidi controls, BOM and U+FFFD;
- `@login` mentions, `#<n>` and `GH-<n>` autolinks, and links to _another_ repo's issue/PR/discussion, which would post a public cross-reference there.

Text inside fenced blocks and exact-run backtick code spans is exempt, since GitHub doesn't link it. The scan errs toward refusing. The rules are the CLAUDE.md _PR bodies_ rule, enforced where it counts: a compromised container could otherwise ping any login as the user.

The result is `results/<id>/result.json`, written once and never echoing job text:

```json
{
  "v": 1,
  "id": "…",
  "job": "open-pr",
  "status": "opened",
  "reason": null,
  "startedAt": "…",
  "finishedAt": "…",
  "durationMs": 2100,
  "runnerVersion": "<sha256>",
  "bodySha256": "<what was sent>",
  "tokenExpiresAt": "2027-11-01T00:00:00Z",
  "tokenWarning": "TOKEN_EXPIRING",
  "pr": {
    "number": 90,
    "url": "https://github.com/radatta/aperture/pull/90",
    "headSha": "…",
    "author": "radatta"
  }
}
```

| Status             | Reason codes                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `opened`, `exists` | — (an open PR for the head returns its URL; the body is not edited)                                                      |
| `rejected`         | `BAD_JSON BAD_FILE TOO_LARGE BAD_ID UNKNOWN_JOB BAD_PARAM BAD_TEXT MENTION HASH_REF XREF HEAD_MISSING HEAD_MISMATCH`     |
| `expired`          | `EXPIRED`                                                                                                                |
| `error`            | `TOKEN_MISSING TOKEN_REJECTED(401) TOKEN_FORBIDDEN(403/404) RATE_LIMITED WRONG_AUTHOR API_FAILED TIMEOUT(30 s per call)` |

Some entries never get a result:

- A bad file name or a dotfile is parked in `state/rejected/`.
- An id whose results dir already exists is logged `DUPLICATE` and doesn't run.
- A held lock leaves the inbox for the next run.
- A symlinked inbox or results dir stops the runner with exit 1.

## The runner

`tools/mailroom/runner.sh` sources `jobs/*.sh`. It uses bash 3.2, `set -euo pipefail`, argv arrays, and no `eval` or `sh -c`. On each run it:

1. **Pins the shared folder.** It refuses a symlinked `.hostjobs`, `inbox` or `results`, then works from a cwd whose `pwd -P` it verified, so swapping a path afterwards changes nothing.
2. **Takes the lock.** It holds `state/lock/` (taken over when older than 15 min) and handles at most 5 entries per run. launchd re-fires while the inbox is non-empty.
3. **Moves each entry out first.** It `mv`s the entry to `state/work/` **before** reading it, and only then refuses a symlink, non-regular file, oversized file or bad JSON. A re-sent id (results dir exists) runs nothing.
4. **Checks the envelope, then the job's own params.** Validation completes before any network call.
5. **Writes the result.** It `mkdir`s `results/<id>` from the pinned cwd, `cd`s in, re-verifies `pwd -P`, refuses a pre-existing `result.json`, and writes with noclobber.

`open-pr`'s calls, in order:

1. `GET /user`: login must be `radatta`. This call's response also gives the token expiry.
2. `GET …/git/ref/heads/<branch>`: the ref must equal `sha`. 404 is `HEAD_MISSING`.
3. `GET …/pulls?head=radatta:<branch>&state=open`: a hit is `exists`.
4. `POST …/pulls` with `{title, head, base: "main", body, draft: false, maintainer_can_modify: false}`: 201, and the response's URL, author and head are checked.

That makes one write, ever.

## Security

| Threat                                            | Control                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Runner bug → the token's worst                    | open or edit a PR on this repo, read it. No push, merge, approval that counts, settings, workflows (_The token_)            |
| The user's full GitHub login                      | never used: no `gh` on the Mac side                                                                                         |
| Code execution via a job                          | jobs are data (jq); argv arrays; launchd runs the installed copy outside the shared folder; `runnerVersion` in every result |
| Exfiltration through the body                     | body inline; nothing read from the shared folder after the move-out                                                         |
| Notifying or cross-referencing people as the user | mention / autolink / cross-repo-link refusal, in the runner and the container                                               |
| Wrong repo, base or head                          | constants; deploy branches refused; head sha and author verified                                                            |
| Symlink / swap games on shared paths              | pinned cwd + `pwd -P` checks, move-out before parse, `mkdir`+noclobber result writes                                        |
| Replay, stale jobs                                | unique ids, `DUPLICATE`, expiry, the head-sha check (a moved branch is refused), the CLI's withdraw                         |
| DoS                                               | 72 KiB, 5 per run, lock, 30 s per call, ThrottleInterval 10 s                                                               |
| Escalation                                        | a user LaunchAgent, no sudo, egress only to api.github.com                                                                  |

Residual: a credential with the user's identity sits in the Mac Keychain, the same posture as the Raycast prod token. It can also comment on or review PRs opened by others; none exist on this repo. With noclobber, bash still writes through a pre-planted symlink to an existing _non-regular_ file, so the fixed result text could land in a FIFO or device. The pre-check and the pinned directory make that a narrow race with no payoff.

## Trial

The trial runs at dev test with the real install, done by a Claude session on the Mac in the worktree, which writes its findings to `localNotes/trial/findings.md`:

1. **Bash 3.2 compatibility:** `bash tools/mailroom/run-fixtures.sh` with the Mac's `/bin/bash`. Want `0 failed`.
2. **Install:** `launchctl print` shows the label and the inbox path, with no error.
3. **Probe:** the container runs `pnpm mailroom probe`. Want `probe ok`, a latency, and the token expiry. If nothing comes back in 180 s, re-install with `--mode poll` and re-probe; that's a design change to log, not a kill. On `TOKEN_MISSING`, run `security find-generic-password -s aperture-mailroom-gh -w >/dev/null` once from Terminal, click Always Allow, and re-probe.
4. **Junk file:** a bad file dropped in the inbox leaves the inbox empty, gets a `BAD_JSON` result, and doesn't loop in the log.
5. **Token wall:** try a Contents write and expect `403` or `404`. If it ever answers `201`, the token is too broad: delete the `mailroom-probe-junk` branch and regenerate the token.

   ```sh
   cd /Users/rahuldatta/Coding/Personal/aperture && curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github+json' --data "{\"ref\":\"refs/heads/mailroom-probe-junk\",\"sha\":\"$(git rev-parse origin/main)\"}" https://api.github.com/repos/radatta/aperture/git/refs
   ```

6. **End to end:** the branch's own phase-10 `pnpm mailroom open-pr`. Want a PR authored by `radatta` with a matching `bodySha256`.

The trial settles two things the docs couldn't (UNVERIFIED until it runs):

- Does QueueDirectories fire when a file is written through the VM's virtiofs share? (Inference: the write is made on the Mac by the VM's file-sharing process, so kqueue should see it.)
- Do launchd's Keychain reads work without a dialog?

## Tests

- `tools/mailroom/run-fixtures.sh` runs every `testdata/jobs.jsonl` case against the real runner and a fresh temp `.hostjobs`. `curl` and `security` are **exported shell functions**, not stub files: a process command line holding a path that ends in the curl name, next to `/tmp/`, trips COI's Sigma rule (COI-INCIDENTS → Incident H). Each case asserts:
  - the result fields;
  - the exact list of `METHOD path` calls;
  - that the token arrives only through the header file and never on argv;
  - that neither the token nor body text reaches the log or a result;
  - that the inbox is empty afterwards;
  - for the canonical case, the exact POST body.
- `scripts/src/mailroom/runner-fixtures.test.ts` runs that suite inside `pnpm test` and CI. It also statically checks the one token source, the four fixed calls, and the absence of `gh`/`git`/`eval`/`sh -c`.
- `job.test.ts` runs the container's `validateJob` over the same JSONL cases (`ts` field), so the two rule sets can't drift.
- `submit.test.ts` and `open-pr.test.ts` cover the file drop, withdraw, unreachable, late pickup, body-hash mismatch, token and version warnings, and the probe.

## Adding a job (PR 2: Simulator)

1. Add `jobs/<name>.sh` defining `validate_<name> W` (prints a reason or nothing) and `run_<name> W PREFIX` (prints `STATUS REASON EXTRA_JSON`).
2. Add the name to `JOBS` in `runner.sh`, and its cases to `jobs.jsonl`.
3. Container side: a module beside `open-pr.ts`, using `submit` / `waitForResult` / `withdraw`. The devcheck's `ctx.ios` step calls it.

Artifacts such as screenshots go inside the pinned result dir. A second credential, such as the dev test user's password, uses the same Keychain-only rule.
