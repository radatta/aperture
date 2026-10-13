# Raycast quick-add

Hotkey → type one line → Enter → a backlog task in Aperture. `aperture-add.sh` is a Raycast Script
Command: the `/mcp` endpoint's `parse_task` (**Claude Haiku 5.5**, server-side — the same parse as the
app's quick add, [docs/areas/tasks/quick-add.md](../../docs/areas/tasks/quick-add.md)) turns the line into a
short title, notes, category, due date/time and estimate, then the script calls `create_task` — no
browser, no Claude chat.

```
aperture, feat: make LC more how I SOHULD use it. ie recruiting tab should …, due tmw
→ Added: feat: make LC more how I SHOULD use it · Aperture · due Sat 10/10 · +notes
```

Haiku only parses (it has no tools); the script does the one write. Needs only `curl`, `jq` and
`security`, all built into macOS 15+. No Anthropic key on the Mac (since 2026-10-12) — the server holds it.

## Install (once)

1. **Store the prod agent token in Keychain.** It's the `AGENT_TOKEN_PROD` value (the same one the
   `aperture` Claude Code connector sends). `-w` with no value makes `security` prompt for it, so it
   never lands in shell history:

   ```sh
   security add-generic-password -a "$USER" -s aperture-agent-token -w
   ```

   To replace it later, add `-U` (update) to the same command. (An `anthropic-api-key` item from before
   2026-10-12 is no longer read — delete it with `security delete-generic-password -s anthropic-api-key`.)

2. **Add the folder to Raycast.** Raycast Settings → Extensions → Script Commands → **Add Directories** →
   this repo's `tools/raycast/`.
3. **Assign a hotkey.** In Raycast, find **Add Aperture Task** → `⌘K` → Configure Command → Hotkey.

If macOS asks whether `security` may read a Keychain item, choose **Always Allow**.

## Use

Type it the way you'd say it: a leading category word (`aperture,`), `due tmw` / `due fri 4pm`, `30m`.
Haiku only sets what you stated — it never invents an estimate — and moves extra detail into notes.
"Today" follows the app's day start (Settings, 4am by default), so `due tmw` typed at 1am means the day
after the one you're still in. A grammar line (space, pipe, space — `memo | ~30 #Admin`) skips the
model and takes the strict [bulk-add grammar](../../docs/areas/tasks/bulk-add.md). A time with no day
(`call dentist 4pm`) means today. A due **time** also puts the task on Google Calendar (auto-sync). The
toast shows what was **saved** (the server's copy), so a wrong guess is visible at once:

| toast                                                 | means                                                                                                                                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Added: <title> · <category> · due Sat 10/10 · 30m …` | parsed and saved; `no category` = none matched                                                                                                                                                     |
| `… · dropped due time` / `unknown category` / …       | Haiku returned a field the server would reject; saved without it                                                                                                                                   |
| `… · calendar sync failed`                            | saved, but the Google event wasn't — retry from the task in the app                                                                                                                                |
| `Added RAW (couldn't parse: <why>): <line>`           | **red** — saved, but unparsed: the parse failed (`timeout`, `api: refusal`, `unavailable: no API key on this stage`, `parse timed out` …) or the server rejected its fields; the line is the title |
| `Failed: <reason>`                                    | nothing was saved, or it can't tell — see Failures                                                                                                                                                 |

Categories come live from the server on every parse (active ones only), so a new category works at
once. (`~/Library/Caches/aperture-raycast/`, the pre-2026-10-12 category cache, is no longer read — safe
to delete.)

## Config

| env var                     | default                           | for                                               |
| --------------------------- | --------------------------------- | ------------------------------------------------- |
| `APERTURE_URL`              | `https://aperture.rahuldatta.dev` | the stage to write to (a local stub, for testing) |
| `APERTURE_KEYCHAIN_SERVICE` | `aperture-agent-token`            | which Keychain item holds the agent token         |

Raycast doesn't pass your shell's env, so these are for terminal runs, e.g. against dev (a dev token
stored as its own Keychain item, so the prod token never goes to dev). The URL must be `https://` (or
`http://127.0.0.1:`/`localhost:` for a local stub):

```sh
APERTURE_URL=https://dev.aperture.rahuldatta.dev APERTURE_KEYCHAIN_SERVICE=aperture-agent-token-dev \
  ./aperture-add.sh "test task"
```

## Failures

| toast                              | means                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `no token in Keychain item …`      | step 1 not done (or a different service name)                                 |
| `token rejected (HTTP 401)`        | Keychain token ≠ the stage's `AGENT_TOKEN` — rotated? re-run step 1 with `-U` |
| `can't reach …`                    | offline, DNS or TLS — the request never left, nothing was added               |
| `… it may have been added …`       | timeout (10s), dropped reply or a 5xx — check the app before retrying         |
| `HTTP <n> — …` / any other message | the server's error, verbatim (or a local check: empty title, missing `jq`)    |

A bad or missing server-side API key still saves the task: it shows as `Added RAW (couldn't parse: api:
HTTP 401 invalid x-api-key)` or `(… unavailable: no API key on this stage)` — the fix is the stage's SSM
parameter ([quick-add → Operator step](../../docs/areas/tasks/quick-add.md#operator-step-once-per-stage)),
not the Mac.

## Security

The agent token is a **full app session** — the script only ever calls `parse_task` and `create_task`,
but a leaked token can do anything the MCP tools can (ceiling:
[docs/areas/mcp](../../docs/areas/mcp/index.md#the-agent-token-is-a-full-app-session--with-a-bounded-ceiling)).
A create-only token is the deferred hardening. The token lives only in Keychain, reaches curl through a
file descriptor (never the process list), and goes only to `APERTURE_URL`. The typed line goes to the
Aperture server, which sends it and your active category labels to the Claude API with the server's key.
