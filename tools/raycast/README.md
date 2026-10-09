# Raycast quick-add

Hotkey → type one line → Enter → a backlog task in Aperture. `aperture-add.sh` is a Raycast Script
Command that calls the `/mcp` endpoint's `create_task` tool directly — no browser, no Claude chat. The
title is sent verbatim (no category/estimate parsing); organize it later in the app or the chat.

Needs only `curl`, `jq` and `security`, all built into macOS 15+.

## Install (once)

1. **Store the prod agent token in Keychain.** It's the `AGENT_TOKEN_PROD` value (the same one the
   `aperture` Claude Code connector sends). `-w` with no value makes `security` prompt for it, so it
   never lands in shell history:

   ```sh
   security add-generic-password -a "$USER" -s aperture-agent-token -w
   ```

   To replace it later, add `-U` (update) to the same command.

2. **Add the folder to Raycast.** Raycast Settings → Extensions → Script Commands → **Add Directories** →
   this repo's `tools/raycast/`.
3. **Assign a hotkey.** In Raycast, find **Add Aperture Task** → `⌘K` → Configure Command → Hotkey.

If macOS asks whether `security` may read the Keychain item, choose **Always Allow**.

## Use

Hotkey, type the title, Enter. The toast reads `Added: <title>`, or `Failed: <reason>` with what to fix.

## Config

| env var                     | default                           | for                                 |
| --------------------------- | --------------------------------- | ----------------------------------- |
| `APERTURE_URL`              | `https://aperture.rahuldatta.dev` | the stage to write to               |
| `APERTURE_KEYCHAIN_SERVICE` | `aperture-agent-token`            | which Keychain item holds the token |

Raycast doesn't pass your shell's env, so these are for terminal runs, e.g. against dev (a dev token
stored as its own Keychain item, so the prod token never goes to dev). The URL must be `https://`:

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

## Security

The agent token is a **full app session** — the script only ever calls `create_task`, but a leaked token
can do anything the MCP tools can (ceiling: [docs/areas/mcp](../../docs/areas/mcp/index.md#the-agent-token-is-a-full-app-session--with-a-bounded-ceiling)).
It lives only in Keychain and reaches curl through a file descriptor, never the process list. A
create-only token is the deferred hardening.
