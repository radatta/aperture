# Raycast quick-add

Hotkey → type one line → Enter → a backlog task in Aperture. `aperture-add.sh` is a Raycast Script
Command: one POST to `/api/capture` ([docs/areas/tasks/capture.md](../../docs/areas/tasks/capture.md)), where
the server parses the line (**Claude Sonnet 5.5** — the same parse as the app's quick add,
[docs/areas/tasks/quick-add.md](../../docs/areas/tasks/quick-add.md)) into a short title, notes, category, due
date/time and estimate, creates the task and answers a receipt — no browser, no Claude chat.

```
aperture, fix: tighten the capture bar spacing on phones. the dock overlaps …, due tmw
→ Added: fix: tighten the capture bar spacing on phones · Aperture · due Sat 10/10 · +notes
```

The model only parses (it has no tools); the server does the one write. Needs only `curl`, `jq` and
`security`, all built into macOS 15+. No Anthropic key on the Mac (since 2026-10-12) — the server holds it.

## Install (once)

1. **Make a capture token and store it in Keychain.** In the app, Settings › Capture → New token for
   `Raycast` → **Make token**, and copy it (it's shown once). `-w` with no value makes `security` prompt
   for it, so it never lands in shell history:

   ```sh
   security add-generic-password -a "$USER" -s aperture-capture-token -w
   ```

   To replace it later, add `-U` (update) to the same command. Before 2026-11, the script read the full
   agent token from the `aperture-agent-token` item; once a capture works, delete that item with
   `security delete-generic-password -s aperture-agent-token` (unless something else on the Mac reads it).
   (An `anthropic-api-key` item from before 2026-10-12 is no longer read either —
   `security delete-generic-password -s anthropic-api-key`.)

2. **Add the folder to Raycast.** Raycast Settings → Extensions → Script Commands → **Add Directories** →
   this repo's `tools/raycast/`.
3. **Assign a hotkey.** In Raycast, find **Add Aperture Task** → `⌘K` → Configure Command → Hotkey.

If macOS asks whether `security` may read a Keychain item, choose **Always Allow**.

## Use

Type it the way you'd say it: a leading category word (`aperture,`), `due tmw` / `due fri 4pm`, `30m`.
The model only sets what you stated — it never invents an estimate — and moves extra detail into notes.
"Today" follows the app's day start (Settings, 4am by default), so `due tmw` typed at 1am means the day
after the one you're still in. A grammar line (space, pipe, space — `memo | ~30 #Admin`) skips the
model and takes the strict [bulk-add grammar](../../docs/areas/tasks/bulk-add.md). A time with no day
(`call dentist 4pm`) means its next occurrence — today, or tomorrow once 4pm has passed — as for the Siri
Shortcut, while a day you write stays as written (`today 9am` at 3pm is overdue); its other spoken rules (a bare "at 5", "tonight", "in 20 minutes") are the Shortcut's
([capture.md → Time rules](../../docs/areas/tasks/capture.md#4-time-rules)).
A due **time** also puts the task on Google Calendar (auto-sync). The same line again within a minute is
answered "Already added", not saved twice. The toast shows what was **saved** (the server's copy), so a
wrong guess is visible at once:

| toast                                                 | means                                                                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Added: <title> · <category> · due Sat 10/10 · 30m …` | parsed and saved; `no category` = none matched                                                                                                                                          |
| `… · dropped due time` / `unknown category` / …       | The model returned a field the server would reject; saved without it                                                                                                                    |
| `… · calendar sync failed`                            | saved, but the Google event wasn't — retry from the task in the app                                                                                                                     |
| `Added RAW (couldn't parse: <why>): <line>`           | **red** — saved, but unparsed: the parse failed (`timeout`, `api: refusal`, `unavailable: no API key on this stage`, `unavailable: daily parse limit reached` …); the line is the title |
| `Already added: <title> …`                            | the same line within a minute — the first capture, answered again; nothing new was saved                                                                                                |
| `Failed: <reason>`                                    | nothing was saved, or it can't tell — see Failures                                                                                                                                      |

Categories come live from the server on every parse (active ones only), so a new category works at
once. (`~/Library/Caches/aperture-raycast/`, the pre-2026-10-12 category cache, is no longer read — safe
to delete.)

## Config

| env var                     | default                           | for                                               |
| --------------------------- | --------------------------------- | ------------------------------------------------- |
| `APERTURE_URL`              | `https://aperture.rahuldatta.dev` | the stage to write to (a local stub, for testing) |
| `APERTURE_KEYCHAIN_SERVICE` | `aperture-capture-token`          | which Keychain item holds the capture token       |

Raycast doesn't pass your shell's env, so these are for terminal runs, e.g. against dev (a dev token
stored as its own Keychain item, so the prod token never goes to dev). The URL must be `https://` (or
`http://127.0.0.1:`/`localhost:` for a local stub):

```sh
APERTURE_URL=https://dev.aperture.rahuldatta.dev APERTURE_KEYCHAIN_SERVICE=aperture-capture-token-dev \
  ./aperture-add.sh "test task"
```

## Failures

| toast                              | means                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `no token in Keychain item …`      | step 1 not done (or a different service name)                                        |
| `token rejected (HTTP 401)`        | revoked in Settings, or not a capture token — make one and re-run step 1 with `-U`   |
| `… (HTTP 429)`                     | the token's daily capture limit (200) — nothing was added; it resets at midnight UTC |
| `… (HTTP 409)`                     | several captures raced on the token and this one gave up — nothing was added; re-run |
| `can't reach …`                    | offline, DNS or TLS — the request never left, nothing was added                      |
| `… it may have been added …`       | timeout (20s), dropped reply or a 5xx — check the app before retrying                |
| `HTTP <n> — …` / any other message | the server's `say`, verbatim (or a local check: empty title, missing `jq`)           |

A bad or missing server-side API key still saves the task: it shows as `Added RAW (couldn't parse: api:
HTTP 401 invalid x-api-key)` or `(… unavailable: no API key on this stage)` — the fix is the stage's SSM
parameter ([quick-add → Operator step](../../docs/areas/tasks/quick-add.md#operator-step-once-per-stage)),
not the Mac.

## Security

The capture token can only add tasks through `/api/capture` — it opens no RPC method, MCP tool or other
route, and is capped (200 captures a day, and 40 model parses a day across all your capture tokens). A leaked one costs junk tasks and cents of
model spend until you revoke it in Settings › Capture, which stops it at once without touching the
phone's token ([capture.md → Token](../../docs/areas/tasks/capture.md#3-token)). It lives only in Keychain,
reaches curl through a file descriptor (never the process list), and goes only to `APERTURE_URL`. The typed line goes to the
Aperture server, which sends it and your active category labels to the Claude API with the server's key.
