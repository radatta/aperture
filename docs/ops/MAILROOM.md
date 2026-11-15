# Mac mailroom — Claude opens PRs as the user

Opening a PR used to be the user's last manual step before a merge: running `gh pr create` on the Mac. The bot can't take it over. A squash commit's author is whoever opened the PR, and `main` must stay the user's (CI-BOT.md). The **mailroom** takes it over instead. Claude drops a job file into a folder the Mac shares with the container. A launchd agent on the Mac picks it up and opens the PR with the user's own **PR-only token**. The PR is the user's, and no one had to touch it.

Think of it as a mailroom. The container drops off a form, the clerk follows a fixed checklist, and the form can only fill in blanks. Built 2026-11-01 on the `mac-mailroom` branch, PR 1 of mac-sim. PR 2 added the `sim` job: the devcheck's iOS rows on the Mac's iOS Simulator, with its own home in [IOS-CHECK.md](IOS-CHECK.md). `clip-paste` (2026-11-13) added the `clip` job: Ctrl+V of a Mac clipboard image in a container Claude Code (_The clip job_). `mailroom-fast-lane` (2026-11-13) split the drain into two lanes, so a short job never waits behind a `sim` run (_The runner_ → _Lanes_). `mailroom-v2` added the `edit-pr` job: after a push, a lane updates its own open PR's text (_The edit-pr job_). It also added the `fixtures` job: a pushed commit's fixture suite, run on the Mac in a sandbox (_The fixtures job_).

```
container (untrusted)                               Mac (trusted; nothing from the shared folder is executed)
pnpm mailroom open-pr --title T
  localNotes/pr-<branch>.md → lint → embed            launchd agents dev.rahuldatta.aperture.mailroom (Aqua):
                                                        the slow lane (sim) and …mailroom.fast (everything else)
  .hostjobs/staging/<id>.json ─rename─▶ .hostjobs/inbox/<id>.json
                                                        │ QueueDirectories (or StartInterval 15 s: --mode poll)
                                                        ▼
                                                      ~/Library/Application Support/aperture-mailroom/bin/runner.sh
                                                        (installed from merged main) mv → state/work-<lane>/ → private copy
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

| Question                                                      | Answer                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening a PR (`POST …/pulls`)                                 | needs Pull requests: write only                                                                                                                                                                                                                                     |
| Editing a PR's title or body (`PATCH …/pulls/{n}`, `edit-pr`) | Pull requests: write as well, and no other permission (GitHub's fine-grained permissions page, checked 2026-11-13)                                                                                                                                                  |
| Merging (`PUT …/pulls/{n}/merge`)                             | needs **Contents: write**, which this token lacks, so it can't merge. The user's admin bypass is moot, because the call is refused at the token layer before any ruleset is consulted.                                                                              |
| Approving                                                     | possible via the API, but [a PR's author can't approve their own PR](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews), and only the user opens PRs here |
| Auto-merge                                                    | off in repo settings (the user confirmed 2026-11-01). Even if it were on, `main`'s ruleset wants a code-owner review that the author can't give.                                                                                                                    |
| The head-sha check (`GET …/git/ref/…`), install's reads       | Contents: read                                                                                                                                                                                                                                                      |
| `POST /markdown`                                              | needs no permission. It's a renderer, and it writes nothing.                                                                                                                                                                                                        |
| Expiry                                                        | Every response carries `GitHub-Authentication-Token-Expiration`. An expired or revoked token gets `401`. A removed permission gets `403` or `404`.                                                                                                                  |

**Worst case if the runner has a bug:** the token opens or edits a PR on this repo, or reads the repo. Nothing more. The repo is private.

**Renew yearly.** GitHub emails before expiry. Every result carries `tokenExpiresAt`, and the CLI prints `TOKEN_EXPIRING` when fewer than 14 days remain. To renew, regenerate the token on GitHub with the same permissions, then run (`<mac-repo>` is the Mac repo path, from the gitignored `.local/mac-root`: main checkout; shown in the SessionStart context):

```sh
cd <mac-repo> && security add-generic-password -a "$USER" -s aperture-mailroom-gh -T /usr/bin/security -U -w
```

The first add is the same command without `-U`. With no value after `-w`, `security` prompts for the token, so it never lands in shell history. `-T` pre-trusts `security`, so launchd's reads don't raise a Keychain dialog.

## Install, update, remove

The installed runner is the **trust boundary**. launchd only ever runs `~/Library/Application Support/aperture-mailroom/bin/`, never the repo's copy, which the container can write. `install.sh` fills that folder **from GitHub, at one commit**: by default `main`'s head, which is code the user approved and merged. It fetches `runner.sh`, `jobs/*.sh` and the plist template with the mailroom token (Contents: read). It never copies a local file. `install.sh` itself is fetched the same way, so nothing from the shared folder is trusted. Run it on the Mac, from the main checkout:

```sh
cd <mac-repo> && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/radatta/aperture/contents/tools/mailroom/install.sh?ref=main')
```

This line is also what the CLI prints when the installed runner is out of date (`INSTALL_LINE` in `open-pr.ts`). It needs only what macOS 15+ ships: `/bin/bash` 3.2, `jq`, `curl`, `security`, `launchctl`, `plutil` and `shasum`. In order, it:

1. Resolves main's head.
2. Fetches the files at that commit.
3. Computes `VERSION`: the sha256 of `runner.sh` followed by `jobs/*.sh`.
4. Renders and lints the two plists, one per lane, from the one template (`@LABEL@`, `@LANE@`, `@THROTTLE@`: slow 10 s, fast 2 s).
5. Checks that `.hostjobs/{staging,inbox,results}` are not symlinks and creates them. This happens before anything is swapped, so a refusal never leaves a half-install.
6. Prints the diff against what's installed (runner, jobs and both plists).
7. Swaps the new copy in.
8. Writes `.hostjobs/installed.json` (installed at, version, commit, mode, lanes). This is only a hint, since the container could forge it, so a failed write doesn't stop the install.
9. Loads both agents with `launchctl bootout` then `bootstrap`, retrying while the old instance tears down. Upgrading from the single agent needs nothing more: its label is the slow lane's, overwritten and re-bootstrapped. An older `install.sh` (a downgrade) leaves the fast agent loaded, running the old runner, which ignores the lane argument and takes `state/lock`. The two then serialise, which is harmless. This branch's `--uninstall` removes it; by hand, `launchctl bootout gui/$(id -u)/dev.rahuldatta.aperture.mailroom.fast && rm ~/Library/LaunchAgents/dev.rahuldatta.aperture.mailroom.fast.plist` (without the `rm`, it comes back at the next login). Both agents are booted out before the files are swapped, so no drain sources a half-installed set of jobs.

The whole script is one `main` function, called on its last line, so a truncated download defines nothing and runs nothing.

**Re-run it after a merge that changes `tools/mailroom/`.** The CLI warns when a result's `runnerVersion` differs from the worktree's.

Other uses:

- **Before a merge.** Only a branch that changes `tools/mailroom/` needs this, for its trial or dev test. Use `?ref=<sha>` in the URL plus `--ref <sha>`. That commit is bot-pushed and nobody has approved it, and its `install.sh` runs directly on the Mac. So **first read `tools/mailroom/` at that commit on github.com**. The script then prints `NOT main's head` and asks `[y/N]` before swapping anything in. Re-run from `main` once it merges.
- **`--mode poll`** swaps the folder watch for a 15 s timer. Use it if QueueDirectories never fires on the shared folder (_Trial_).
- **`--uninstall`** removes both agents and the installed copy. It keeps `.hostjobs/` and the Keychain item. Remove those with `security delete-generic-password -s aperture-mailroom-gh`, and revoke the token on GitHub.
- **The log** is `~/Library/Logs/aperture-mailroom/agent.log`, shared by both agents; a lane's lines carry `slow` or `fast` after the time. It holds codes, ids, durations and HTTP statuses, never the token or the body.

## Using it (container)

| Command                                                  | Does                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm mailroom open-pr --title "<title>" [--wait <s>]`   | Opens this pushed branch's PR as the user, from the worktree's `localNotes/pr-<branch>.md`. Exit 0 prints `opened <url>` or `exists <url>`.                                                                                                                                                                          |
| `pnpm mailroom edit-pr [--title "<title>"] [--wait <s>]` | After a push to an open PR: replaces its body (and title, when given) with `localNotes/pr-<branch>.md`, as the user. Exit 0 prints `edited <url>` once the PR reads back with that body. _The edit-pr job_.                                                                                                          |
| `pnpm mailroom fixtures [--sha <sha>]`                   | Runs the fixture suite at a pushed commit (default: this branch's head) on the Mac, under its bash 3.2, sandboxed. It queues in the slow lane, so start it in the background. Exit 0 prints `fixtures pass on the Mac: N/N`, 1 a fail (the failing cases, and the log tail's path), 3 no pickup. _The fixtures job_. |
| `pnpm mailroom probe [--wait <s>]`                       | Runs the whole path (inbox → launchd → Keychain → GitHub) on a pushed branch with a zero sha, so it stops at `HEAD_MISMATCH` before any write. Exit 0 prints the token expiry. `HEAD_MISSING` fails, because a pushed branch is invisible only to a token without repo access.                                       |
| `pnpm mailroom clip-probe [--out <png>] [--wait <s>]`    | The `clip` job by hand: the Mac clipboard's image to `localNotes/clip-probe.png` (default). Exit 0 served, 1 refused (prints the reason and what to do), 3 no answer (withdrawn). _The clip job_.                                                                                                                    |
| `pnpm mailroom sim-probe [--sign-in]` / `sim-shutdown`   | The `sim` job's whole path with no assertions (boot, launch the web app, screenshot), or a shutdown. IOS-CHECK.md → _Proving the Mac side_.                                                                                                                                                                          |

`open-pr` works through these steps:

1. Refuses a detached HEAD, a deploy branch, or an unpushed branch (`pnpm bot push` first).
2. Lints the title and body with the runner's fast-pass rules and prints a fix-it hint on failure.
3. Skips the job if the container's read-only `gh` already sees an open PR. This check is best-effort.
4. Submits the job and waits **75 s plus 30 s of grace**, counted from when the command started. That keeps it under the Bash tool's 120 s default timeout, because a killed caller would leave the job queued. If the pre-submit checks have left under 10 s of that budget, it queues nothing and exits 3.
5. Checks that the result's `bodySha256` matches the file, and that the PR's head is the pushed sha. A push that landed mid-job fails loudly.

Exit codes: 1 is a refusal or failure, printing the code and the renewal line for `TOKEN_*`. 2 is a usage error. **3 is `MAC_UNREACHABLE`**: no result in time, because the Mac is asleep, or the agent isn't installed or didn't fire. A running `sim` job no longer delays it: `open-pr` runs in the fast lane (_The runner_ → _Lanes_). The job is **withdrawn** from the inbox so it can't fire later. If the Mac already took it, the CLI waits out the grace period. If there's still no answer, it says the PR may yet open, and to check `gh pr list --head <branch>` before using the hand-off line. Otherwise it prints whether the Mac was ever installed and the age of the last result, plus the hand-off line:

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
| `opened`, `exists` | none. If a PR is already open for the head, the result returns its URL and the body is not edited: that is `edit-pr`'s job, and the CLI prints its line.                                |
| `rejected`         | `BAD_JSON BAD_FILE TOO_LARGE BAD_ID UNKNOWN_JOB BAD_PARAM BAD_TEXT MENTION HASH_REF XREF HEAD_MISSING HEAD_MISMATCH`                                                                    |
| `expired`          | `EXPIRED`                                                                                                                                                                               |
| `error`            | `TOKEN_MISSING TOKEN_REJECTED(401) TOKEN_FORBIDDEN(403, or 404 off the ref call) RATE_LIMITED(403/429 with no rate left or retry-after) WRONG_AUTHOR API_FAILED TIMEOUT(30 s per call)` |

Some entries never get a result:

- A bad name or a dotfile is parked in `state/rejected/`.
- An id whose results dir exists is logged `DUPLICATE` and doesn't run.
- A held lock leaves the inbox for the next run, and so does an entry for the other lane.
- A symlinked or moved `.hostjobs`, `inbox` or `results` stops the runner with exit 1.

## The edit-pr job

`open-pr` never edits: on `exists` it leaves the body alone. So after a fix is pushed, a lane runs `pnpm mailroom edit-pr` and the Mac replaces the open PR's body, and its title when `--title` is given, through the same token. Before this the user ran `gh pr edit` by hand.

- **Params** are open-pr's, with the title optional: `{branch, sha, body, bodySha256}` plus `title?`. The same envelope, fast pass and title rule apply (`mr_validate` in `jobs/open-pr.sh`, `validateJob` in the container). There is never a PR number: the Mac finds the PR itself.
- **Five calls, one write** (`jobs/edit-pr.sh`). The first two, `GET /user` and the branch ref, are open-pr's (`mr_begin`). Then `GET …/pulls?head=<owner>:<branch>&state=open`, `POST /markdown` over the new title and body (`mr_render`), and `PATCH …/pulls/<n>` with only `{body}` or `{title, body}`, never state, base, draft or `maintainer_can_modify`.
- **The PR must be** the only open one from the branch, the user's, onto `main`, from this repo, with its head at the job's `sha`, so the body describes what's pushed. Otherwise the Mac refuses it, before the render and the write.
- **The result** is `edited` plus `pr`, and its `bodySha256` hashes the body GitHub returned, not the one sent. The CLI fails loudly if that differs, or if the PR then reads back with another body or title through the container's read-only `gh`.

| Status     | Reason codes, and what they mean                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `edited`   | none. `pr` as for `opened`                                                                                                                      |
| `rejected` | `NO_PR` (none open: open one first), `MANY_PRS`, `WRONG_BASE`, `HEAD_MISMATCH` (the branch or the PR's head isn't the job's sha), and open-pr's |
| `error`    | `WRONG_AUTHOR` (the token's login, or the PR's author, isn't the owner), and open-pr's                                                          |

When the Mac doesn't answer, the CLI prints the user's line: `gh pr edit <branch> --body-file localNotes/pr-<branch>.md`, plus `--title` when one was given.

## The fixtures job

A `tools/mailroom/` branch's trial starts with its fixture suite on the Mac, under `/bin/bash` 3.2, since the container's bash 5 hid a real bug (MIXED_TEXT, PR 170). The user used to paste that line. Now `pnpm mailroom fixtures` asks the Mac to run it. Params: `{sha}`.

**This is the one job that runs code that isn't merged main:** unreviewed bash at whatever sha the container names, usually a bot push (once the repo is public, GitHub serves a fork's commit through it too). The same happened before, whenever the line was pasted without reading the branch. The job (`jobs/fixtures.sh`) bounds it like this:

- **No install change.** `GET …/compare/main...<sha>` first. A diff that touches `install.sh` or a plist template (renames included) is `TOUCHES_INSTALL`. A list GitHub cut at 300 files is `DIFF_TOO_LARGE`, because the check can't be made. Both are refused before anything is fetched, and such a branch's suite stays the user's, by hand (_Trial_ step 2).
- **From GitHub at the sha, never the shared folder.** `GET …/tarball/<sha>` (Contents: read) is followed to GitHub's archive host. curl drops the token header on that hop, because the redirect URL carries its own short-lived grant. The archive is capped at 64 MiB and 120 s, and unpacked into a fresh temp dir outside the mount.
- **Under `sandbox-exec`**, for both the unpack and the run, each started inside the temp dir. The profile (`fx_profile`, pinned line by line in `runner-fixtures.test.ts`) allows everything, then takes away:
  - all network;
  - every write but the run's own temp dir, `/dev/null`, `/dev/zero` and `/dev/fd`;
  - every read under `/Users`, `/Volumes` and `/System/Volumes/Data/Users`, so no home folder, the shared one and the runner's own state included;
  - the Keychain daemons and `/usr/bin/security`;
  - the ways to hand work to a process outside the sandbox: LaunchServices and `open`, Apple Events and `osascript`, launchd job creation and `launchctl`, the pasteboard, CoreSimulator and `xcrun`, and `defaults`. The suite stubs every tool it drives, so it needs none of them.

  A preflight runs `/usr/bin/true` under the profile first: a profile this macOS won't compile is `SANDBOX_FAILED`, and a Mac without `sandbox-exec` is `SANDBOX_MISSING`. The job never runs unsandboxed. `sandbox-exec` is deprecated but still on macOS.

- **The output** goes to a file the runner made in its own work dir, which the sandbox can neither read nor replace. Nothing after the run reads a path inside the temp dir, which the suite controls.

- **A clean environment** (`env -i`, the system `PATH`, `HOME` and `TMPDIR` inside the temp dir), stdin closed, a 1 GiB file-size limit (`ulimit -f`), and caps: 2 min for the unpack, 10 for the suite (`FX_TIMEOUT`). `fx_cap` runs each in its own process group. Past the cap it stops the group and then kills it, since a TERM can be ignored. After a normal exit it kills the group too, so nothing the suite backgrounded outlives it.
- **The slow lane** runs it (`SLOW_JOBS`, ids `…Z-fx-…`): a fixture suite never runs beside a sim job, which slows the sim's reads (IOS-CHECK.md → _Runtime_). The cap touches the lane's locks as it waits.

| Status     | Reason codes, and what they mean                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`     | none. `fixtures: {passed, failed, cases, failing: []}`: the summary line said 0 failed, and every case passed                                                                                             |
| `fail`     | `FIXTURES_FAILED`: any failure, a shortfall, a non-zero exit or no summary line. `failing` holds up to 20 names (ASCII), `exit` the suite's code                                                          |
| `rejected` | `TOUCHES_INSTALL`, `DIFF_TOO_LARGE`, `HEAD_MISSING` (no such commit), `BAD_PARAM`                                                                                                                         |
| `error`    | `SANDBOX_MISSING`, `SANDBOX_FAILED` (the profile didn't compile here), `TIMEOUT` (the 10-min cap), `API_FAILED` (an archive without `run-fixtures.sh`, or a compare without a file list), and the token's |

The last 400 lines of the suite's output, printable ASCII only, go to `results/<id>/fixtures.log`, written as results are.

## The clip job

Ctrl+V in a container Claude Code pastes the Mac's clipboard image. Claude Code (2.1.322, checked in its binary) pastes an image on Linux by running `xclip -selection clipboard -t TARGETS -o | grep image/…` and then `xclip -selection clipboard -t image/png -o > <file>`; any failure is a silent "no image". The container has no clipboard, so **`tools/coi/xclip`** stands in for xclip: linked from `~/.local/bin/xclip`, ahead of `/usr/bin` on PATH (COI-SANDBOX.md → _Pasting images_).

```
Ctrl+V in Claude Code
  xclip … -t TARGETS -o ──▶ tools/coi/xclip: inbox/<id>.json {job: "clip", params: {}, expiresInMin: 1}
                                                   │ launchd → runner.sh → jobs/clip.sh
                                                   ▼ gates, then one JXA read: public.png, else public.tiff → PNG
  keeps the PNG (≤ 10 s, per tmux pane) ◀──── results/<id>/clip.png + result.json (status served)
  prints "image/png"; deletes clip.png from the shared folder
  xclip … -t image/png -o ──▶ prints the kept PNG once
```

**The shim answers exactly those two argvs.** Every other call exits 1 with no output and no job: text reads (`-t text/plain`, a bare `-o`, the primary selection), copy (stdin), the bmp fallback. Text never crosses, and nothing passes through to the real xclip. TARGETS waits at most **15 s** for the result (`CLIP_WAIT_MS`), then withdraws the job like `open-pr` does, so a Ctrl+V with the Mac asleep costs 15 s and pastes nothing. If the Mac already took the job, it waits up to 17 s more (the Mac's read is capped at 10 s, its banner, when on, at 5 s), so a late image is still collected rather than left in the shared folder. Each TARGETS also sweeps: an uncollected `clip.png` older than 30 s, and a clip job's result dir or withdrawn file older than an hour. A running `sim` job doesn't hold a paste up: clips run in the fast lane (_The runner_ → _Lanes_), whose lock also serialises them, so the per-copy and per-minute caps can't race. Each call logs one line to `~/.cache/xclip-shim/log` (ids, outcomes, sizes; never content). Cmd+V in iTerm is a bracketed paste through tmux and never reaches xclip, so pasting text is unchanged. A Ctrl+V with only text on the clipboard costs one `NO_IMAGE` job and pastes nothing.

**The Mac side, `jobs/clip.sh`.** `params` must be `{}` and `expiresInMin` at most 2 (`BAD_PARAM`). The gates are checked in order, each before any pasteboard data is read:

1. At most `CLIP_PER_MIN` = 6 serves in the last minute (`RATE_LIMITED`, checked before osascript runs).
2. The frontmost app is iTerm2 or Terminal (`CLIP_FRONT_IDS`; else `NOT_FRONTMOST`). A paste is happening there.
3. The copied image (the pasteboard's `changeCount`) has been served fewer than `CLIP_PER_CC` = 3 times (`REPEAT`; copy it again). This stands in for a freshness window: the pasteboard records no copy time.

The read is JXA fed to `osascript -l JavaScript -` on stdin from a constant, capped at 10 s. It asks the pasteboard for `changeCount`, `types` and `dataForType` of `public.png` or `public.tiff`, and nothing else: it never reads text data. **A copy that also lists plain or rich text is refused** (`MIXED_TEXT`). Office apps and others put a rendered image of the selection beside its text, so an Excel range would otherwise cross as a picture. A screenshot carries no text type. Safari's Copy Image is expected not to either, and if it does, the result's `types` shows it. TIFF is re-encoded to PNG, because a screenshot can be either and `«class PNGf»` fails on TIFF-only. The bash side then trusts the file, not the report: a regular file, PNG magic, at most `CLIP_MAX_BYTES` = 16 MiB. It writes `results/<id>/clip.png` as in _The runner_ step 6, counts the serve in `$STATE/clip.json` (Mac-private), and logs a line (size, a sha prefix, `changeCount`, source, frontmost app). That Mac log line is the record of each serve: a macOS banner per serve, "Sent a N KB image to the container", is off since 2026-11-13, by the maintainer's choice (`CLIP_BANNER=0`; 1 turns it back on).

| Status     | Reason codes, and what they mean                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `served`   | none. `clip: {bytes, sha256, changeCount, source: png\|tiff, frontmost}`                                                                                                                                                        |
| `rejected` | `NO_IMAGE` (no image type), `MIXED_TEXT` (plus `types`), `NOT_FRONTMOST` (plus `frontmost`, when it reads as a bundle id), `REPEAT`, `RATE_LIMITED`, `TOO_LARGE`, `BAD_PARAM`                                                   |
| `error`    | `PASTEBOARD_DENIED` (an image type listed, its data withheld: macOS pasteboard privacy), `CLIP_FAILED` (a read, re-encode or write failed, or no PNG magic), `TIMEOUT` (10 s; a pending macOS permission prompt reads this way) |

**macOS pasteboard privacy.** macOS 15.4 added `NSPasteboard.accessBehavior` and a "paste from other apps" prompt as a developer preview. Whether macOS 26 prompts a LaunchAgent's `osascript` is unconfirmed (research 2026-11-13), and the first real Ctrl+V settles it. A prompt left waiting holds the read until its 10 s cap and reads `TIMEOUT`: answer it, then press Ctrl+V again. An outright denial (the image listed, its data withheld) reads `PASTEBOARD_DENIED`: allow `osascript` under System Settings → Privacy & Security, if macOS lists it there.

## The runner

`tools/mailroom/runner.sh` sources `jobs/*.sh`. It uses bash 3.2, `set -euo pipefail` and argv arrays, with no `eval` and no `sh -c`. On each run it does six things:

1. **Pins the shared folder.** It refuses a symlinked `.hostjobs`, `inbox` or `results`, and refuses a `.hostjobs` whose real path isn't the one the plist passed. That catches a swap between the check and the resolve. It then works from a cwd whose `pwd -P` it has verified, so swapping a path afterwards changes nothing.
2. **Takes its lane's lock** (_Lanes_). A run handles at most 5 entries of its own lane, and launchd re-fires while the inbox isn't empty.
3. **Takes each entry out of the shared folder, then makes a private copy.** It `mv`s the entry to its lane's work dir (`state/work-slow/`, `state/work-fast/`, or `state/work/` with no lane argument). That file can still be the container's inode, through a hard link or a handle opened before the move. So it refuses symlinks, non-regular files and any file with a **link count above 1**. It then copies the content into a fresh file it creates itself (`head -c`, noclobber) and deletes the moved one. **Every later read uses that copy only.** A re-sent id runs nothing.
4. **Validates fully before any network call.** It checks size, then exactly one JSON value, then the envelope, then the job's own params.
5. **Runs the job.** `sim`: IOS-CHECK.md. `open-pr` makes these calls, in this order:
   1. `GET /user`: the login must be `radatta`, and the token's expiry is read here.
   2. `GET …/git/ref/heads/<branch>`: the ref must equal `sha`. A 404 is `HEAD_MISSING`.
   3. `GET …/pulls?head=radatta:<branch>&state=open`: a hit returns `exists`.
   4. `POST /markdown` on the title and body: the render check.
   5. `POST …/pulls` with `{title, head, base: "main", body, draft: false, maintainer_can_modify: false}`: it must return 201, and the response's URL and author are checked. **This is the one write, ever.** The CLI then compares the PR's head with the pushed sha.
6. **Writes the result.** It `mkdir`s `results/<id>` from the pinned cwd — right before running a validated job (`make_rdir`: the job's artifacts and heartbeat go there, and the container reads its appearance as the pickup), or at write time for a file refused earlier — `cd`s in, re-verifies `pwd -P`, refuses a pre-existing `result.json`, and writes with noclobber. A job writes its artifacts the same way: pinned cwd, no existing entry, noclobber, and a rename (never a follow) for the heartbeat.

## Security

| Threat                                                    | Control                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner bug → the token's worst                            | Open or edit a PR on this private repo, and read it (`edit-pr` makes that edit on purpose: the text only, of the one open PR from a lane's branch). No push, merge, approval that counts, settings or workflows (_The token_).                                                                                                                                                   |
| The user's full GitHub login                              | Never used: there is no `gh` on the Mac side.                                                                                                                                                                                                                                                                                                                                    |
| Changed code on the Mac                                   | launchd runs only the installed copy, fetched from merged `main` on GitHub (_Install_). `runnerVersion` and the commit are in every result and in `installed.json`.                                                                                                                                                                                                              |
| Code execution via a job                                  | Jobs are data (jq), and every command takes argv arrays. The one exception, by design: `fixtures` runs a pushed commit's suite from GitHub, sandboxed (no network, writes only to its temp dir, no reads under `/Users` or the Keychain), in a clean environment, capped at 10 min, and never for a diff touching the installer (_The fixtures job_).                            |
| Content changed after validation (hard link, open handle) | Link count must be 1, and a private copy is made before any read.                                                                                                                                                                                                                                                                                                                |
| Exfiltration through the body                             | The body is inline. The runner reads no container-named path.                                                                                                                                                                                                                                                                                                                    |
| Notifying or cross-referencing people as the user         | The fast pass, then GitHub's own render. Both run on the Mac.                                                                                                                                                                                                                                                                                                                    |
| Wrong repo, base or head                                  | Repo and base are constants. Deploy branches are refused. The head sha and the author are verified. `edit-pr` finds its PR by branch, never by a number from the container, and checks its base, repo, head and author first.                                                                                                                                                    |
| Symlink or swap games on shared paths                     | Real-path pin, pinned cwd plus `pwd -P`, move-out before parse, and results written with `mkdir` plus noclobber.                                                                                                                                                                                                                                                                 |
| Replay, stale jobs                                        | Unique ids, `DUPLICATE`, expiry, the head-sha check (a branch that moved is refused), and the CLI's withdraw.                                                                                                                                                                                                                                                                    |
| DoS                                                       | Caps of 72 KiB, 5 per run per lane and 30 s per call, plus a lock per lane and ThrottleInterval 10 s (slow) / 2 s (fast).                                                                                                                                                                                                                                                        |
| Escalation                                                | A user LaunchAgent with no sudo. Egress goes only to api.github.com, plus GitHub's archive host on the `fixtures` tarball's redirect (https only).                                                                                                                                                                                                                               |
| The `clip` job: harvesting clipboard images               | Images only: no text data is ever read, a copy that also carries text is refused (`MIXED_TEXT`: no picture of an Excel range), and the shim refuses every text argv. A terminal must be frontmost, each copy serves 3 times at most, 6 serves a minute, a 2-min job life, and a Mac log line per serve (no banner since 2026-11-13, by the maintainer's choice). _The clip job_. |
| The `sim` job (dev test user's password, driving the sim) | Keychain-only password, typed only on dev's Cognito page, never read back; allowlisted ops; no network from the job. IOS-CHECK.md → _Security_.                                                                                                                                                                                                                                  |

Residual risks:

- The `fixtures` job runs unreviewed code on the Mac under a deny-list profile (`(allow default)`, then the denials above). A Mach or XPC service the list doesn't name could still do work outside the sandbox. A deny-default profile is the follow-up, once a trial shows what the suite needs. The trial probes each named channel (_Trial_).
- The `clip` job lets the container read the clipboard's image on request, by design. Bounded by the gates above, but a compromised container can still take the image currently on the clipboard while a terminal is in front, up to 3 times. The Mac log records each serve; no banner shows it (off by the maintainer's choice, 2026-11-13).
- A credential with the user's identity sits in the Mac Keychain. That's the same posture as the Raycast prod token.
- The token can also comment on or review PRs opened by others. None exist on this repo.
- Noclobber in bash still writes through a pre-planted symlink to an existing _non-regular_ file. A FIFO planted into the fresh result dir in the instant between the pre-check and the write could hang the runner. That's DoS only: kill the stuck run. The narrow race carries no data.
- The trust in `install.sh` rests on the one-line fetch above. A compromised container could hand over a different line, and the local copy of this doc is writable from the container too. So check the line against [this doc on github.com at `main`](https://github.com/radatta/aperture/blob/main/docs/ops/MAILROOM.md#install-update-remove).
- Before its own merge, the mailroom's trial installs a bot-pushed commit (_Install_ → before a merge). That's one install, gated by reading the code at that commit on github.com and by the `[y/N]` prompt. It's superseded by the `main` install at merge.

## Trial

The trial runs at dev test with the real install. A Claude session on the Mac does it, and writes its findings to the worktree's `localNotes/trial/findings.md`. That session is **started outside the repo** (`cd ~ && claude`): Claude Code started in a project runs that project's `.claude/hooks/*.sh`, which are container-writable. **It runs nothing from the shared folder.** Everything it runs runs as the user, and the user can read the Keychain token, so a container-writable script would get that token. Every script it runs comes from GitHub at the reviewed commit.

1. **Review:** read `tools/mailroom/` at the branch's sha on github.com: `install.sh`, `runner.sh`, `jobs/`, `run-fixtures.sh` and `testdata/`.
2. **Fixtures, from GitHub, outside the mount.** The container runs `pnpm mailroom fixtures --sha <sha>`, and the installed runner runs the suite from GitHub's tarball, sandboxed (_The fixtures job_). Want `fixtures pass`. A branch whose diff touches `install.sh` or the plist template is refused (`TOUCHES_INSTALL`), and so is any branch while the installed runner predates the job. Then it's by hand, as before: fetch the tarball at that sha with the mailroom token (Contents: read) into a fresh Mac temp dir, and run `/bin/bash tools/mailroom/run-fixtures.sh` there. On Darwin it pins `/bin/bash` 3.2 and the system `PATH`, as launchd would. Want `0 failed`. The trial runbook has the exact line.
3. **Install:** the branch's commit, with the `--ref` form under _Install_. Answer `y` only if the diff matches what step 1 read. A fresh install shows the files in full (`diff -ruN`) and the rendered plist. `launchctl print … | grep -A8 'event triggers'`, for each of the two labels, should show the label and the inbox path, with no error.
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

### Lanes

launchd runs one process per label: a second start of a running label is a no-op. So one agent can't serve a clip while its own process is inside a 10-minute sim. Two agents watch the same inbox instead, each running the installed `runner.sh <hostjobs> <state> slow|fast`:

- **slow** (`dev.rahuldatta.aperture.mailroom`): the jobs in `SLOW_JOBS`, today `sim` and `fixtures`, so the Simulator never gets two at once and never runs beside a fixture suite. Lock `state/lock/`, taken over when older than 15 min; the sim job touches it on every op, so a long run never reads as stale.
- **fast** (`…mailroom.fast`, ThrottleInterval 2 s, so a Ctrl+V retry doesn't wait 10 s): everything else: `open-pr` (and its probe), `edit-pr`, `clip`, and junk, so junk never waits behind a sim (unless it's named like one). Lock `state/lock-fast/`, taken over when older than 5 min. Each drain touches its locks before every job, so only a crashed drain's lock ages; the longest fast job is an `open-pr`, 5 calls at 30 s each.
- **No lane argument** (a hand run) takes both locks, as one drain did before. The bench passes `slow`, on its own private state dir.

The slow lane takes the entries **named** like a sim or fixtures job, `<stamp>Z-ios-…` or `<stamp>Z-fx-…` (`sim.ts` and `makeFixturesJob` build every such id so, and the bench's too), and nothing in the shared folder is opened before the move: everything else is the fast lane's, junk included. A drain leaves the other lane's entries in place, uncounted, and sources the job files only once it takes one, so the fast agent's re-fires every 2 s behind a queued sim cost a directory listing each. The name is the container's word, like the content, so it only routes. The snapshot's `job` decides: a `sim` or `fixtures` (in `SLOW_JOBS`) runs only in a drain holding `state/lock/`, and a `clip` (in `FAST_JOBS`, which keep state: `clip.json`'s caps) only in one holding `state/lock-fast/`; a mismatch is `rejected BAD_FILE`. An `open-pr` or `edit-pr` may run in either; the container never names one so (`makeOpenPrJob` prefixes a branch named `ios-…` or `fx-…` with `pr-`, `makeEditPrJob` every branch with `edit-`), but an older worktree's would take the slow lane and wait its turn, as every job did before. Routing costs no fork per entry, so a flood of the other lane's entries costs a drain only a pass of bash pattern matches. Each lane has its own work dir, since a drain clears and deletes `<stem>.*` there freely. Two drains of the same lane can still both take over one stale lock; only a hand run beside the agent can get there.

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
- **Lanes** have their own cases (`lane: "slow" | "fast"`, the runner's third argument; `locks` checks which lock dirs a run leaves; every fixture's state dir has a space in its path, like the Mac's): each lane leaves the other's jobs and the fast lane takes junk, a sim not named as one and a clip named as one are refused, an open-pr named `ios-…` runs in the slow lane, a held or stale lock per lane (and the 5- vs 15-minute rules at 6 minutes), and the per-lane cap counting only a lane's own entries. A real-concurrency block after the shards runs a slow drain inside a 20 s sim op. Beside it: a second slow drain (exits, and the next sim stays queued); a fast drain given a clip under the running sim's id (it leaves it, as the slow lane's; the slow lane's private snapshot survives; the next slow drain runs nothing for it, `DUPLICATE`); and a fast drain that serves a clip before the sim's result exists. Then a slow and a fast drain start together on one sim, 10 times: only the slow takes it, and the fast never touches it.
- **`job.test.ts`** runs the container's `validateJob` over the same JSONL cases (the `ts` field), so the two fast passes can't drift.
- **`submit.test.ts` and `open-pr.test.ts`** cover the file drop, withdraw, unreachable, late pickup, a body-hash mismatch, the token and version warnings, the probe, and the iPhone-checks banner.
- **The `fixtures` job** has its own cases (`kind: "fixtures"`, base `fixturesBase`). `sandbox-exec` and `tar` are stub files on the case's `PATH`, since the job runs them through `env -i`. The `sandbox-exec` stub records its profile (`sbIncludes`) and runs the rest, and `tar` unpacks the case's `fxScript` as the archive's `run-fixtures.sh`. The cases cover: a pass in a clean environment (the suite's `env` shows none of the runner's variables, and the token check over results and logs would catch one), a fail with its names, a shortfall, no summary, the 20-name cap, each install-path refusal, the 300-file cut, and the lane rules for `…Z-fx-…`. A harness check runs `fx_cap` with a 1 s cap over a tree with a background child: 124, and the child is gone. `runner-fixtures.test.ts` pins the profile lines, that `tar` and `bash` run only inside `sandbox-exec`, and the compare and tarball as the job's only calls.
- **The `edit-pr` job** has its own cases (`kind: "edit-pr"`, base `editBase`): each refusal before the write (no PR, two, another author, base, repo or head, a branch pushed past the job, a mention in the render), the exact PATCH body (`patchBody`: the text only, the title only when given), a PATCH answering for another PR, and a stored body that differs from the sent one. `runner-fixtures.test.ts` pins each PR job's five calls in order (begin, lookup, render, write) and that the PATCH body holds only `title` and `body`; `edit-pr.test.ts` covers the CLI: the read-back, the hints, and the hand-off line.
- **The `clip` job** has its own cases (`kind: "clip"`, base `clipBase`): `osascript` is an exported-function stub answering from the tape, and a JXA read that answers 0 writes a PNG (or, on cue, a GIF or a file one byte over the cap) to its path argv. A `clip-state=` setup seeds the Mac-private serve counts, and `clipState` checks them afterwards. `runner-fixtures.test.ts` pins the gates' constants, the three pasteboard calls, the two `osascript` lines and no network. `clip.test.ts` covers `clip-probe`, and `xclip-shim.test.ts` runs the real `tools/coi/xclip` against a temp `.hostjobs`, with the test playing the Mac. It also pins the timing headroom: the shim's grace covers the Mac's 10 s read + 5 s banner (when on) + 2 s, `clip.ts` mirrors the shim's caps, a Ctrl+V never hangs past 35 s, and the shim has no busy check. Its give-up test reads the shim's own elapsed time from its log, not the test's clock: on a loaded CI VM the two disagreed by about 90 ms (F70).
- **The `sim` job** has its own cases in the same JSONL (`kind: "sim"`, base `simBase`). `axe`, `xcrun`, `open`, `pgrep`, `caffeinate` and `xcodebuild` are exported-function stubs answering from a per-case **tape** (`{m: argv substring, rc, n: uses, out}`, first match wins, defaults on line 2); short `sleep`s return at once. Each case asserts the result, ordered tool calls that must happen and calls that must not, how often the test user's password was read and typed (and never on argv), artifact files, and that the password reaches no log or result. `sim.test.ts` covers pickup, withdraw, late pickup, the heartbeat and result mapping; `runner-fixtures.test.ts` pins the sim job's constants and its no-network, tools-by-name rules.

## Adding a job

1. Add one file `jobs/<name>.sh` (the installer and the CLI hash `jobs/*.sh` in name order, and a helper file's place in that order can differ by locale), defining `validate_<name> W` (prints a reason, or nothing) and `run_<name> W PREFIX RESULT_DIR` (prints `STATUS REASON EXTRA_JSON`; artifacts go under `RESULT_DIR`, written as in _The runner_ step 6).
2. Add the name to `JOBS` in `runner.sh` (and to `SLOW_JOBS` if it drives the Simulator or runs for minutes, with an id prefix in `SLOW_RE`), any new `error` reasons its validator returns to `status_of` (a run's own status passes through as printed), and its cases to `gen-jobs.py`.
3. On the container side, mirror the validator and wait for the result: `open-pr.ts` (one short wait) or `sim.ts` (pickup, then a heartbeat) are the two patterns.

A second credential follows the same Keychain-only rule (the `sim` job's test-user password: IOS-CHECK.md).
