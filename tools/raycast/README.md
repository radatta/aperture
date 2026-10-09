# Raycast quick-add

Hotkey → type one line → Enter → a backlog task in Aperture. `aperture-add.sh` is a Raycast Script
Command: **Claude Haiku 5.5** turns the line into a short title, notes, category, due date/time and
estimate, then the script calls the `/mcp` endpoint's `create_task` — no browser, no Claude chat.

```
aperture, feat: make LC more how I SOHULD use it. ie recruiting tab should …, due tmw
→ Added: feat: make LC more how I SHOULD use it · Aperture · due Sat 10/10 · +notes
```

Haiku only parses (it has no tools); the script does every write. Needs only `curl`, `jq` and
`security`, all built into macOS 15+.

## Install (once)

1. **Store the prod agent token in Keychain.** It's the `AGENT_TOKEN_PROD` value (the same one the
   `aperture` Claude Code connector sends). `-w` with no value makes `security` prompt for it, so it
   never lands in shell history:

   ```sh
   security add-generic-password -a "$USER" -s aperture-agent-token -w
   ```

2. **Store an Anthropic API key** (console.anthropic.com → API keys) the same way:

   ```sh
   security add-generic-password -a "$USER" -s anthropic-api-key -w
   ```

   To replace either later, add `-U` (update) to the same command.

3. **Add the folder to Raycast.** Raycast Settings → Extensions → Script Commands → **Add Directories** →
   this repo's `tools/raycast/`.
4. **Assign a hotkey.** In Raycast, find **Add Aperture Task** → `⌘K` → Configure Command → Hotkey.

If macOS asks whether `security` may read a Keychain item, choose **Always Allow**.

## Use

Type it the way you'd say it: a leading category word (`aperture,`), `due tmw` / `due fri 4pm`, `30m`.
Haiku only sets what you stated — it never invents an estimate — and moves extra detail into notes.
The toast shows what was **saved** (the server's copy), so a wrong guess is visible at once:

| toast                                                 | means                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `Added: <title> · <category> · due Sat 10/10 · 30m …` | parsed and saved; `no category` = none matched                          |
| `… · dropped due time` / `unknown category` / …       | Haiku returned a field the server would reject; saved without it        |
| `… · categories: stale` / `unavailable`               | couldn't refresh the category list; used the old copy / none            |
| `Added RAW (couldn't parse: <why>): <line>`           | Haiku failed (timeout 4s, refusal, no API key …); the line is the title |
| `Failed: <reason>`                                    | nothing was saved, or it can't tell — see Failures                      |

Categories are cached for a day in `~/Library/Caches/aperture-raycast/categories.json` (retired ones
left out). Delete the file to pick up a new category right away.

## Config

| env var                      | default                           | for                                        |
| ---------------------------- | --------------------------------- | ------------------------------------------ |
| `APERTURE_URL`               | `https://aperture.rahuldatta.dev` | the stage to write to                      |
| `APERTURE_KEYCHAIN_SERVICE`  | `aperture-agent-token`            | which Keychain item holds the agent token  |
| `ANTHROPIC_KEYCHAIN_SERVICE` | `anthropic-api-key`               | which Keychain item holds the API key      |
| `ANTHROPIC_URL`              | `https://api.anthropic.com`       | the Claude API (a local stub, for testing) |

Raycast doesn't pass your shell's env, so these are for terminal runs, e.g. against dev (a dev token
stored as its own Keychain item, so the prod token never goes to dev). URLs must be `https://` (or
`http://127.0.0.1:`/`localhost:` for a local stub):

```sh
APERTURE_URL=https://dev.aperture.rahuldatta.dev APERTURE_KEYCHAIN_SERVICE=aperture-agent-token-dev \
  ./aperture-add.sh "test task"
```

Delete the category cache when switching stages — the ids differ.

## Failures

| toast                              | means                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `no token in Keychain item …`      | step 1 not done (or a different service name)                                 |
| `token rejected (HTTP 401)`        | Keychain token ≠ the stage's `AGENT_TOKEN` — rotated? re-run step 1 with `-U` |
| `can't reach …`                    | offline, DNS or TLS — the request never left, nothing was added               |
| `… it may have been added …`       | timeout (10s), dropped reply or a 5xx — check the app before retrying         |
| `HTTP <n> — …` / any other message | the server's error, verbatim (or a local check: empty title, missing `jq`)    |

A bad API key isn't a failure: it shows as `Added RAW (couldn't parse: HTTP 401 invalid x-api-key)` —
re-run step 2 with `-U`.

## Security

The agent token is a **full app session** — the script only ever calls `list_categories` and
`create_task`, but a leaked token can do anything the MCP tools can (ceiling:
[docs/areas/mcp](../../docs/areas/mcp/index.md#the-agent-token-is-a-full-app-session--with-a-bounded-ceiling)).
A create-only token is the deferred hardening. Both secrets live only in Keychain, each reaches curl
through a file descriptor (never the process list), and each goes only to its own host. The typed line
and your category labels go to the Claude API.
