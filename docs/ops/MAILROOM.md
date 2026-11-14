# Mac mailroom — Claude opens PRs as the user

Opening a PR used to be the user's last manual step before a merge: running `gh pr create` on the Mac. The bot can't take it over. A squash commit's author is whoever opened the PR, and `main` must stay the user's (CI-BOT.md). The **mailroom** takes it over instead. Claude drops a job file into a folder the Mac shares with the container. A launchd agent on the Mac picks it up and opens the PR with the user's own **PR-only token**. The PR is the user's, and no one had to touch it.

Think of it as a mailroom. The container drops off a form, the clerk follows a fixed checklist, and the form can only fill in blanks. Built 2026-11-01 on the `mac-mailroom` branch, PR 1 of mac-sim. PR 2 added the `sim` job: the devcheck's iOS rows on the Mac's iOS Simulator, with its own home in [IOS-CHECK.md](IOS-CHECK.md).

```
container (untrusted)                               Mac (trusted; nothing from the shared folder is executed)
pnpm mailroom open-pr --title T
  localNotes/pr-<branch>.md → lint → embed            launchd agent dev.rahuldatta.aperture.mailroom (Aqua)
  .hostjobs/staging/<id>.json ─rename─▶ .hostjobs/inbox/<id>.json
                                                        │ QueueDirectories (or StartInterval 15 s: --mode poll)
                                                        ▼
                                                      ~/Library/Application Support/aperture-mailroom/bin/runner.sh
                                                        (installed from merged main) mv → state/work/ → private copy
                                                        jq validate → jobs/open-pr.sh (curl + jq):
                                                          token ← Keychain aperture-mailroom-gh
                                                          GET /user (= radatta)  GET …/git/ref/heads/<b> (= sha)
                                                          GET …/pulls?head=radatta:<b>&state=open
                                                          POST /markdown (render: no mention / foreign link)
                                                          POST …/pulls
  polls results/<id>/result.json (2 s, ≤ 75 s) ◀───── .hostjobs/results/<id>/result.json
  prints the URL; no answer → withdraws the job, prints the hand-off command
```

`.hostjobs/` sits at the root of the main checkout, so every worktree shares it. The container finds it through `git rev-parse --git-common-dir`, the same anchor as the bot's `secretsDir()`. It is gitignored.

## The token

The mailroom uses **no `gh`, no `git`, and never the user's own GitHub login**. It has its own fine-grained PAT. That token reaches only `curl`, and only `https://api.github.com`. The runner makes the five calls above, and `install.sh` makes its own reads: `commits/main`, and the files at one commit (_Install_).

**Spec:**

- name `aperture-mailroom`, owner `radatta`
- Repository access: **Only select repositories → aperture**
- Permissions: **Pull requests: Read and write**, **Contents: Read**, and Metadata: Read (added automatically). Everything else: No access.
- Expiry: 1 year.

To create it: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. This one was created 2026-11-01.

**It lives only in the Mac's Keychain**, as generic-password item `aperture-mailroom-gh`, read by `security find-generic-password -s aperture-mailroom-gh -w`. **Never put it in a file under the repo folder.** `/workspace` _is_ the Mac's repo folder, so every file there (`.hostjobs/` and the worktrees included) is readable by the container. A token stored there becomes the container's token. `runner-fixtures.test.ts` checks that the runner reads the token from no other source: no environment variable, no file, nothing on argv. For `install.sh` it checks that the token comes from `security` and reaches `curl` through the header file. The token reaches `curl` as a header through a process-substituted file, the `tools/raycast` idiom.

What the docs settle (2026-11-01, [fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)):

| Question                                                | Answer                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening a PR (`POST …/pulls`)                           | needs Pull requests: write only                                                                                                                                                                                                                                     |
| Merging (`PUT …/pulls/{n}/merge`)                       | needs **Contents: write**, which this token lacks, so it can't merge. The user's admin bypass is moot, because the call is refused at the token layer before any ruleset is consulted.                                                                              |
| Approving                                               | possible via the API, but [a PR's author can't approve their own PR](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews), and only the user opens PRs here |
| Auto-merge                                              | off in repo settings (the user confirmed 2026-11-01). Even if it were on, `main`'s ruleset wants a code-owner review that the author can't give.                                                                                                                    |
| The head-sha check (`GET …/git/ref/…`), install's reads | Contents: read                                                                                                                                                                                                                                                      |
| `POST /markdown`                                        | needs no permission. It's a renderer, and it writes nothing.                                                                                                                                                                                                        |
| Expiry                                                  | Every response carries `GitHub-Authentication-Token-Expiration`. An expired or revoked token gets `401`. A removed permission gets `403` or `404`.                                                                                                                  |

**Worst case if the runner has a bug:** the token opens or edits a PR on this repo, or reads the repo. Nothing more. The repo is private.

**Renew yearly.** GitHub emails before expiry. Every result carries `tokenExpiresAt`, and the CLI prints `TOKEN_EXPIRING` when fewer than 14 days remain. To renew, regenerate the token on GitHub with the same permissions, then run:

```sh
cd /Users/rahuldatta/Coding/Personal/aperture && security add-generic-password -a "$USER" -s aperture-mailroom-gh -T /usr/bin/security -U -w
```

The first add is the same command without `-U`. With no value after `-w`, `security` prompts for the token, so it never lands in shell history. `-T` pre-trusts `security`, so launchd's reads don't raise a Keychain dialog.

## Install, update, remove

The installed runner is the **trust boundary**. launchd only ever runs `~/Library/Application Support/aperture-mailroom/bin/`, never the repo's copy, which the container can write. `install.sh` fills that folder **from GitHub, at one commit**: by default `main`'s head, which is code the user approved and merged. It fetches `runner.sh`, `jobs/*.sh` and the plist template with the mailroom token (Contents: read). It never copies a local file. `install.sh` itself is fetched the same way, so nothing from the shared folder is trusted. Run it on the Mac, from the main checkout:

```sh
cd /Users/rahuldatta/Coding/Personal/aperture && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/radatta/aperture/contents/tools/mailroom/install.sh?ref=main')
```

This line is also what the CLI prints when the installed runner is out of date (`INSTALL_LINE` in `open-pr.ts`). It needs only what macOS 15+ ships: `/bin/bash` 3.2, `jq`, `curl`, `security`, `launchctl`, `plutil` and `shasum`. In order, it:

1. Resolves main's head.
2. Fetches the files at that commit.
3. Computes `VERSION`: the sha256 of `runner.sh` followed by `jobs/*.sh`.
4. Renders and lints the plist.
5. Checks that `.hostjobs/{staging,inbox,results}` are not symlinks and creates them. This happens before anything is swapped, so a refusal never leaves a half-install.
6. Prints the diff against what's installed (runner, jobs and plist).
7. Swaps the new copy in.
8. Writes `.hostjobs/installed.json` (installed at, version, commit, mode). This is only a hint, since the container could forge it, so a failed write doesn't stop the install.
9. Loads the agent with `launchctl bootout` then `bootstrap`, retrying while the old instance tears down.

The whole script is one `main` function, called on its last line, so a truncated download defines nothing and runs nothing.

**Re-run it after a merge that changes `tools/mailroom/`.** The CLI warns when a result's `runnerVersion` differs from the worktree's.

Other uses:

- **Before a merge.** Only a branch that changes `tools/mailroom/` needs this, for its trial or dev test. Use `?ref=<sha>` in the URL plus `--ref <sha>`. That commit is bot-pushed and nobody has approved it, and its `install.sh` runs directly on the Mac. So **first read `tools/mailroom/` at that commit on github.com**. The script then prints `NOT main's head` and asks `[y/N]` before swapping anything in. Re-run from `main` once it merges.
- **`--mode poll`** swaps the folder watch for a 15 s timer. Use it if QueueDirectories never fires on the shared folder (_Trial_).
- **`--uninstall`** removes the agent and the installed copy. It keeps `.hostjobs/` and the Keychain item. Remove those with `security delete-generic-password -s aperture-mailroom-gh`, and revoke the token on GitHub.
- **The log** is `~/Library/Logs/aperture-mailroom/agent.log`. It holds codes, ids, durations and HTTP statuses, never the token or the body.

## Using it (container)

| Command                                                | Does                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm mailroom open-pr --title "<title>" [--wait <s>]` | Opens this pushed branch's PR as the user, from the worktree's `localNotes/pr-<branch>.md`. Exit 0 prints `opened <url>` or `exists <url>`.                                                                                                                                    |
| `pnpm mailroom probe [--wait <s>]`                     | Runs the whole path (inbox → launchd → Keychain → GitHub) on a pushed branch with a zero sha, so it stops at `HEAD_MISMATCH` before any write. Exit 0 prints the token expiry. `HEAD_MISSING` fails, because a pushed branch is invisible only to a token without repo access. |
| `pnpm mailroom sim-probe [--sign-in]` / `sim-shutdown` | The `sim` job's whole path with no assertions (boot, launch the web app, screenshot), or a shutdown. IOS-CHECK.md → _Proving the Mac side_.                                                                                                                                    |

`open-pr` works through these steps:

1. Refuses a detached HEAD, a deploy branch, or an unpushed branch (`pnpm bot push` first).
2. Lints the title and body with the runner's fast-pass rules and prints a fix-it hint on failure.
3. Skips the job if the container's read-only `gh` already sees an open PR. This check is best-effort.
4. Submits the job and waits **75 s plus 30 s of grace**, counted from when the command started. That keeps it under the Bash tool's 120 s default timeout, because a killed caller would leave the job queued. If the pre-submit checks have left under 10 s of that budget, it queues nothing and exits 3.
5. Checks that the result's `bodySha256` matches the file, and that the PR's head is the pushed sha. A push that landed mid-job fails loudly.

Exit codes: 1 is a refusal or failure, printing the code and the renewal line for `TOKEN_*`. 2 is a usage error. **3 is `MAC_UNREACHABLE`**: no result in time, because the Mac is asleep, or the agent isn't installed or didn't fire — or it's busy: the runner drains one job at a time, so an `open-pr` queued behind a running `sim` job (up to 10 min, IOS-CHECK.md) waits it out and can read as unreachable. Rerun after the devcheck. The job is **withdrawn** from the inbox so it can't fire later. If the Mac already took it, the CLI waits out the grace period. If there's still no answer, it says the PR may yet open, and to check `gh pr list --head <branch>` before using the hand-off line. Otherwise it prints whether the Mac was ever installed and the age of the last result, plus the hand-off line:

```sh
cd <Mac worktree> && gh pr create --title "…" --body-file localNotes/pr-<branch>.md
```

The title rule excludes `"`, `$`, backticks and `!`, so that line always pastes cleanly. In autonomous mode, exit 3 is the `CC blocked` path (CLAUDE.md → _Feature workflow_).

## Job and result

The job is `inbox/<id>.json`, one JSON value, at most 72 KiB. The envelope below is every job's; `params` and the result's extra fields are the job's own (the `sim` job's: IOS-CHECK.md → _The op language_, _Results_). A result's `job` is the validated job name, or `null` for a file refused before its envelope was read:

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

The rules, checked before any network call:

- `id` matches `^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}$` and equals the file's stem.
- `job` is on the allowlist.
- `submittedAt` is ISO with no millis, at most 5 min in the future. The job expires after `expiresInMin`, which is 1–60.
- `branch` matches `^[a-z0-9][a-z0-9-]{0,62}$` and isn't `main`, `master` or `dev`.
- `sha` is 40 hex characters.
- `title` matches `^[A-Za-z0-9][A-Za-z0-9 .,:;()/+_&'-]{3,99}$`.
- `body` is 1–64 KiB, and `bodySha256` must match it.
- Repo, base (`main`) and owner are constants in the runner, never params, and no extra keys are allowed at either level.
- Anchored checks also refuse a newline: in jq, `$` matches before a final one.

The **body travels inside the job**, so the runner never reads a path the container names. It's checked twice:

1. **The fast pass** runs in jq on the Mac, and in `validateJob` in the container so the error comes early and can be fixed. It refuses:
   - C0/C1 controls (tab and newline allowed), the soft hyphen, zero-width and invisible characters, line/paragraph separators, bidi controls (U+061C included), BOM, U+FFFD, tag characters, variation selectors, and Hangul and Mongolian fillers;
   - any HTML entity (`&#x40;octocat` renders as a mention);
   - `@login`, `#<n>` and `GH-<n>`;
   - links to _another_ repo's issue, PR or discussion, which would post a cross-reference there. This one applies to the title too, since GitHub links titles.

   Text inside fenced blocks and exact-run backtick spans is exempt, so `` `@types/node` `` is fine.

2. **GitHub's renderer has the last word.** The runner sends the title and body to `POST /markdown` (`gfm`, context `radatta/aperture`) and scans the HTML in jq (`RENDER_JQ`). First, any tag holding a literal `<` is refused as `BAD_TEXT`. GitHub escapes `<` inside attributes (checked live 2026-11-01), so such a tag is HTML the scan can't read safely: a fake `<code>` inside an attribute would otherwise make the code strip swallow a real link. Next, GitHub decides what is code: `<pre>` and `<code>` are dropped. Then it refuses:
   - `MENTION`, for a `user-mention` or `team-mention` class;
   - `XREF`, for an `issue-link` whose href isn't exactly this repo's `issues|pull|discussions/<n>` (so `../` can't walk out), or a foreign issue URL anywhere in the HTML, attributes included;
   - `MENTION` or `HASH_REF`, for the fast-pass patterns over what's left as text, once tags and this repo's own issue links are removed.

   The text scan matters because the token sees only this repo. A reference to a private repo or team the token can't see renders as plain text, not as a link with a class, but GitHub would still process it as the user when the PR is made. Rendering catches what a regex over markdown can't see: indented or tilde fences, HTML blocks, link titles, entities. Round 1's review found 8 such bypasses of the fast pass. The scan runs in one jq call, with no pipe. Round 2 found that `grep -o | grep -q` under `pipefail` passed silently on large HTML because of SIGPIPE. The classes were checked against the live renderer on 2026-11-01 with `gh api markdown`: `@octocat`, `&#x40;octocat` and cross-repo URLs all render with those classes, and code spans don't.

These rules are the CLAUDE.md _PR bodies_ rule, enforced where it counts. Without them, a compromised container could ping any login as the user. The repo is private, so only people with access would be notified, but the guard still holds.

The result, `results/<id>/result.json`, is written once and never echoes job text:

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

| Status             | Reason codes                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opened`, `exists` | none. If a PR is already open for the head, the result returns its URL and the body is not edited.                                                                                      |
| `rejected`         | `BAD_JSON BAD_FILE TOO_LARGE BAD_ID UNKNOWN_JOB BAD_PARAM BAD_TEXT MENTION HASH_REF XREF HEAD_MISSING HEAD_MISMATCH`                                                                    |
| `expired`          | `EXPIRED`                                                                                                                                                                               |
| `error`            | `TOKEN_MISSING TOKEN_REJECTED(401) TOKEN_FORBIDDEN(403, or 404 off the ref call) RATE_LIMITED(403/429 with no rate left or retry-after) WRONG_AUTHOR API_FAILED TIMEOUT(30 s per call)` |

Some entries never get a result:

- A bad name or a dotfile is parked in `state/rejected/`.
- An id whose results dir exists is logged `DUPLICATE` and doesn't run.
- A held lock leaves the inbox for the next run.
- A symlinked or moved `.hostjobs`, `inbox` or `results` stops the runner with exit 1.

## The runner

`tools/mailroom/runner.sh` sources `jobs/*.sh`. It uses bash 3.2, `set -euo pipefail` and argv arrays, with no `eval` and no `sh -c`. On each run it does six things:

1. **Pins the shared folder.** It refuses a symlinked `.hostjobs`, `inbox` or `results`, and refuses a `.hostjobs` whose real path isn't the one the plist passed. That catches a swap between the check and the resolve. It then works from a cwd whose `pwd -P` it has verified, so swapping a path afterwards changes nothing.
2. **Takes a lock.** `state/lock/` is taken over when it's older than 15 min. A run handles at most 5 entries, and launchd re-fires while the inbox isn't empty.
3. **Takes each entry out of the shared folder, then makes a private copy.** It `mv`s the entry to `state/work/`. That file can still be the container's inode, through a hard link or a handle opened before the move. So it refuses symlinks, non-regular files and any file with a **link count above 1**. It then copies the content into a fresh file it creates itself (`head -c`, noclobber) and deletes the moved one. **Every later read uses that copy only.** A re-sent id runs nothing.
4. **Validates fully before any network call.** It checks size, then exactly one JSON value, then the envelope, then the job's own params.
5. **Runs the job.** `sim`: IOS-CHECK.md. `open-pr` makes these calls, in this order:
   1. `GET /user`: the login must be `radatta`, and the token's expiry is read here.
   2. `GET …/git/ref/heads/<branch>`: the ref must equal `sha`. A 404 is `HEAD_MISSING`.
   3. `GET …/pulls?head=radatta:<branch>&state=open`: a hit returns `exists`.
   4. `POST /markdown` on the title and body: the render check.
   5. `POST …/pulls` with `{title, head, base: "main", body, draft: false, maintainer_can_modify: false}`: it must return 201, and the response's URL and author are checked. **This is the one write, ever.** The CLI then compares the PR's head with the pushed sha.
6. **Writes the result.** It `mkdir`s `results/<id>` from the pinned cwd — right before running a validated job (`make_rdir`: the job's artifacts and heartbeat go there, and the container reads its appearance as the pickup), or at write time for a file refused earlier — `cd`s in, re-verifies `pwd -P`, refuses a pre-existing `result.json`, and writes with noclobber. A job writes its artifacts the same way: pinned cwd, no existing entry, noclobber, and a rename (never a follow) for the heartbeat.

## Security

| Threat                                                    | Control                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner bug → the token's worst                            | Open or edit a PR on this private repo, and read it. No push, merge, approval that counts, settings or workflows (_The token_).                                     |
| The user's full GitHub login                              | Never used: there is no `gh` on the Mac side.                                                                                                                       |
| Changed code on the Mac                                   | launchd runs only the installed copy, fetched from merged `main` on GitHub (_Install_). `runnerVersion` and the commit are in every result and in `installed.json`. |
| Code execution via a job                                  | Jobs are data (jq), and every command takes argv arrays.                                                                                                            |
| Content changed after validation (hard link, open handle) | Link count must be 1, and a private copy is made before any read.                                                                                                   |
| Exfiltration through the body                             | The body is inline. The runner reads no container-named path.                                                                                                       |
| Notifying or cross-referencing people as the user         | The fast pass, then GitHub's own render. Both run on the Mac.                                                                                                       |
| Wrong repo, base or head                                  | Repo and base are constants. Deploy branches are refused. The head sha and the author are verified.                                                                 |
| Symlink or swap games on shared paths                     | Real-path pin, pinned cwd plus `pwd -P`, move-out before parse, and results written with `mkdir` plus noclobber.                                                    |
| Replay, stale jobs                                        | Unique ids, `DUPLICATE`, expiry, the head-sha check (a branch that moved is refused), and the CLI's withdraw.                                                       |
| DoS                                                       | Caps of 72 KiB, 5 per run and 30 s per call, plus the lock and ThrottleInterval 10 s.                                                                               |
| Escalation                                                | A user LaunchAgent with no sudo. Egress goes only to api.github.com.                                                                                                |
| The `sim` job (dev test user's password, driving the sim) | Keychain-only password, typed only on dev's Cognito page, never read back; allowlisted ops; no network from the job. IOS-CHECK.md → _Security_.                     |

Residual risks:

- A credential with the user's identity sits in the Mac Keychain. That's the same posture as the Raycast prod token.
- The token can also comment on or review PRs opened by others. None exist on this repo.
- Noclobber in bash still writes through a pre-planted symlink to an existing _non-regular_ file. A FIFO planted into the fresh result dir in the instant between the pre-check and the write could hang the runner. That's DoS only: kill the stuck run. The narrow race carries no data.
- The trust in `install.sh` rests on the one-line fetch above. A compromised container could hand over a different line, and the local copy of this doc is writable from the container too. So check the line against [this doc on github.com at `main`](https://github.com/radatta/aperture/blob/main/docs/ops/MAILROOM.md#install-update-remove).
- Before its own merge, the mailroom's trial installs a bot-pushed commit (_Install_ → before a merge). That's one install, gated by reading the code at that commit on github.com and by the `[y/N]` prompt. It's superseded by the `main` install at merge.

## Trial

The trial runs at dev test with the real install. A Claude session on the Mac does it, and writes its findings to the worktree's `localNotes/trial/findings.md`. That session is **started outside the repo** (`cd ~ && claude`): Claude Code started in a project runs that project's `.claude/hooks/*.sh`, which are container-writable. **It runs nothing from the shared folder.** Everything it runs runs as the user, and the user can read the Keychain token, so a container-writable script would get that token. Every script it runs comes from GitHub at the reviewed commit.

1. **Review:** read `tools/mailroom/` at the branch's sha on github.com: `install.sh`, `runner.sh`, `jobs/`, `run-fixtures.sh` and `testdata/`.
2. **Fixtures, from GitHub, outside the mount.** Fetch the tarball at that sha with the mailroom token (Contents: read) into a fresh Mac temp dir, then run `/bin/bash tools/mailroom/run-fixtures.sh` there. On Darwin it pins `/bin/bash` 3.2 and the system `PATH`, as launchd would. Want `0 failed`. The trial runbook has the exact line.
3. **Install:** the branch's commit, with the `--ref` form under _Install_. Answer `y` only if the diff matches what step 1 read. A fresh install shows the files in full (`diff -ruN`) and the rendered plist. `launchctl print … | grep -A8 'event triggers'` should show the label and the inbox path, with no error.
4. **Probe:** the container runs `pnpm mailroom probe`. Want `probe ok`, a latency, and the token expiry.
   - No result in time: re-install with `--mode poll` and re-probe. That's a logged design change, not a kill.
   - `TOKEN_MISSING`: run `security find-generic-password -s aperture-mailroom-gh -w >/dev/null` once from Terminal, click Always Allow, and re-probe.
5. **Junk file:** a bad file dropped into the inbox should leave the inbox empty, write a `BAD_JSON` result, and not loop in the log.
6. **Token wall:** a Contents write should get `403` or `404`. If it ever answers `201`, the token is too broad: delete the `mailroom-probe-junk` branch and regenerate the token. Use any existing commit sha as `<main sha>`. Don't take it from `git` in the checkout, because that `.git` is container-writable too.

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github+json' --data '{"ref":"refs/heads/mailroom-probe-junk","sha":"<main sha>"}' https://api.github.com/repos/radatta/aperture/git/refs
   ```

7. **End to end:** the branch's own phase-10 `pnpm mailroom open-pr`. Want a PR authored by `radatta`, with a matching `bodySha256`.
8. **After merge:** re-install from `main` with the plain command under _Install_.

**Trial run 2026-11-04 UTC, at commit `567213a`: steps 1–6 passed.** It settled two things that were unverified until then:

- **QueueDirectories fires** on a file written through the VM's virtiofs share. Pickup took under 1 s, the probe answered in 778 ms, and `--mode poll` wasn't needed.
- **launchd's Keychain read works with no dialog**, for this item, created with `-T /usr/bin/security`.

The rest of the run:

- Fixtures: 117/117 under the Mac's `/bin/bash` 3.2.
- Junk file: `BAD_JSON` in 28 ms, with one log line and no loop.
- Token wall: `403`. A follow-up read found no branch.
- Result files are written `0600`/`0700` (the runner's `umask 077`). The container reads them through the share as the same user.

Findings are in the worktree's `localNotes/trial/findings.md`, archived at Cleanup.

## Tests

- **`tools/mailroom/run-fixtures.sh`** runs every `testdata/jobs.jsonl` case against the real runner and a fresh temp `.hostjobs`, in shards (`MAILROOM_FIXTURE_JOBS`, default the machine's cores up to 4, `1` runs them in order), so output comes grouped by shard. The pass count must equal the case count, so a lost shard fails the run. `curl` and `security` are stubbed as **exported shell functions**, not stub files. A process command line holding a path that ends in the curl name, next to `/tmp/`, trips COI's Sigma rule (COI-INCIDENTS → Incident H). Each case asserts:
  - the result fields;
  - the exact list of `METHOD path` calls;
  - that the token arrives only through the header file, never on argv;
  - that neither the token nor body text reaches the log or a result;
  - that the inbox is empty afterwards;
  - for the canonical case, the exact `/markdown` and `/pulls` request bodies.

  The suite passes only if every case ran, so a harness that ran nothing fails. The cases include several that were mutation-tested as load-bearing:
  - a hard-linked entry;
  - a `.hostjobs` under a symlinked parent, which tests the real-path pin;
  - a foreign link before 1,000 of this repo's own, which tests the SIGPIPE fix. It needs about 100 KiB of HTML to overflow the pipe buffer; 100 links did not.

  They also include:
  - every reviewer bypass body, each of which must reach the render check;
  - plain-text mentions and references in the render;
  - GitHub's real escaped render of the attribute trick;
  - each reason code.

  The cases are generated: edit `testdata/gen-jobs.py`, then run `python3 tools/mailroom/testdata/gen-jobs.py tools/mailroom/testdata/jobs.jsonl`. A test fails if the committed JSONL drifts from the generator.

- **`scripts/src/mailroom/runner-fixtures.test.ts`** runs that suite inside `pnpm test` and CI — on a PR only when one of its inputs changed, and on a main push unless a PR run already ran it on that exact tree ([INFRA.md](../arch/INFRA.md) §9). It also statically checks:
  - the one token source;
  - the five fixed calls;
  - no `gh`, `git`, `eval` or `sh -c`;
  - that `install.sh` reads only GitHub, at `$ref`.
- **`job.test.ts`** runs the container's `validateJob` over the same JSONL cases (the `ts` field), so the two fast passes can't drift.
- **`submit.test.ts` and `open-pr.test.ts`** cover the file drop, withdraw, unreachable, late pickup, a body-hash mismatch, the token and version warnings, the probe, and the iPhone-checks banner.
- **The `sim` job** has its own cases in the same JSONL (`kind: "sim"`, base `simBase`). `axe`, `xcrun`, `open`, `pgrep`, `caffeinate` and `xcodebuild` are exported-function stubs answering from a per-case **tape** (`{m: argv substring, rc, n: uses, out}`, first match wins, defaults on line 2); short `sleep`s return at once. Each case asserts the result, ordered tool calls that must happen and calls that must not, how often the test user's password was read and typed (and never on argv), artifact files, and that the password reaches no log or result. `sim.test.ts` covers pickup, withdraw, late pickup, the heartbeat and result mapping; `runner-fixtures.test.ts` pins the sim job's constants and its no-network, tools-by-name rules.

## Adding a job

1. Add one file `jobs/<name>.sh` (the installer and the CLI hash `jobs/*.sh` in name order, and a helper file's place in that order can differ by locale), defining `validate_<name> W` (prints a reason, or nothing) and `run_<name> W PREFIX RESULT_DIR` (prints `STATUS REASON EXTRA_JSON`; artifacts go under `RESULT_DIR`, written as in _The runner_ step 6).
2. Add the name to `JOBS` in `runner.sh`, any new `error` reasons its validator returns to `status_of` (a run's own status passes through as printed), and its cases to `gen-jobs.py`.
3. On the container side, mirror the validator and wait for the result: `open-pr.ts` (one short wait) or `sim.ts` (pickup, then a heartbeat) are the two patterns.

A second credential follows the same Keychain-only rule (the `sim` job's test-user password: IOS-CHECK.md).
