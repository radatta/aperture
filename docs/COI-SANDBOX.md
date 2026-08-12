# Aperture on code-on-incus (COI) — sandbox runbook

Run Claude Code against this repo inside an **Incus system container** — as a day-to-day dev
environment *and* an unattended overnight rig (`--dangerously-skip-permissions`). The container,
not Claude's own Bash sandbox, is the isolation boundary. Two profiles off one base config.

Posture, either profile: **code / test / build only — no local deploy, no AWS creds.** Deploys run
through CI on a branch push; local `cdk deploy` is off-path and the harness (`.claude/hooks`) blocks
pushes to `main`/`dev` regardless.

Built + verified on an Apple-silicon Mac, 2026-08-10/11.

---

## Stack

```
Mac  →  raw Lima VM (name: incus)  →  Incus 7.3 (LXC) system container  →  Claude Code
```

`limactl` runs on the Mac; `coi` / `incus` run inside the VM. The repo is a host mount, so the
container and your normal Mac editor share the same files live (VS Code opens the local folder and
sees edits as they land).

Why raw Lima, not Colima: COI's network-monitoring wrapper is written against `limactl shell <host>`
and a `[monitoring.nft] lima_host` key, and its CI has a lima lane. Colima adds the exact abstraction
COI's "monitoring degraded on macOS/Colima" note fingers. Not OrbStack (proprietary; Incus-nesting
untested for a security sandbox). Incus uses **system containers (LXC)**, not VMs — no nested virt,
no M-series VM caveat.

## Run

**Daytime (interactive):**
```bash
cd ~/Coding/Personal/aperture && coi shell
```
Bypass perms, restricted network, Vite `5173` mapped out, no runtime cap. `pnpm dev` inside →
`http://localhost:5173` in your Mac browser.

**Overnight (unattended):**
```bash
coi run --profile aperture-night -- claude --dangerously-skip-permissions -p "<task>"
```
Strict allowlist network, 10h hard cap. **Keep the Mac awake** (Amphetamine or `caffeinate`) — if the
Mac sleeps the Lima VM suspends and the run stalls.

## One-time setup

Each step below fixed a real failure — none are optional on a fresh Mac.

1. **Incus ≥ 6.1** (idmapping support). Ubuntu 26.04 ships 6.0.5 → add the Zabbly repo and upgrade
   (this rig runs 7.3). Older Incus fails container launch with an idmap error.
2. **Delegate host UID 501 to Incus.** Launch otherwise fails *"UID namespace isolation not
   supported"*:
   ```bash
   echo 'root:501:1' | sudo tee -a /etc/subuid
   echo 'root:501:1' | sudo tee -a /etc/subgid
   sudo systemctl restart incus
   ```
   (501 = the Mac user's uid; the container's `code` user is uid 1000, mapped `both 501 1000`.)
3. **Make the repo mount writable.** Lima mounts the Mac home **read-only** (`virtiofs ro`) by
   default, so the container workspace is read-only. Fix with `limactl edit incus` — add a scoped
   writable mount for the repo path (it overmounts the ro parent):
   ```yaml
   mounts:
     - location: "~/Coding/Personal/aperture"
       writable: true
   ```
   virtiofs perf is fine (~30s cold `pnpm install`).
4. **Auth token.** `claude setup-token` mints a ~1-year subscription OAuth token. Store it in a
   mode-600 file — **not** an env var in a committed config, **not** a wholesale `~/.claude` mount
   (COI warns that clobbers its own credential injection):
   ```bash
   claude setup-token                          # copy the token
   umask 077 && printf %s "<token>" > ~/.coi-claude-token
   ```
   Wire it in the **user-scope** COI config (below) via `env_commands`.

## Config files

Four files. Only the first lives in this repo; the rest are machine-local and never committed.

| File | Scope | Purpose |
| --- | --- | --- |
| `.coi/config.toml` | **repo (committed)** | Daytime posture: `coi-default` image, `permission_mode=bypass`, CPU/mem caps, `network.mode=restricted`, Vite `5173` port map, monitoring on. Secret-free. |
| `~/.coi/config.toml` | user (trusted) | Auth injection: `[defaults.env_commands]` `CLAUDE_CODE_OAUTH_TOKEN = "cat $HOME/.coi-claude-token"`. |
| `~/.coi-claude-token` | user, mode 600 | The token itself. Never mounted into the workspace. |
| `~/.coi/profiles/aperture-night/config.toml` | user (trusted) | Night deltas: `network.mode=allowlist` + `allowed_domains`, `limits.runtime.max_duration="10h"`, `auto_stop=true`, `[monitoring.nft] enabled=false`. |

Night profile, in full:
```toml
[limits.runtime]
max_duration = "10h"
auto_stop = true

[network]
mode = "allowlist"
allowed_domains = ["api.anthropic.com", "registry.npmjs.org"]

[monitoring.nft]
enabled = false
```
Configs **merge**: user → repo → `--profile` layered on top as deltas; scalars are last-wins.

## Gotchas (don't re-derive these)

- **Two config formats — the big one.** The main/project config (`~/.coi/config.toml`,
  `.coi/config.toml`) is the `Config` struct: `forward_env` / `env_commands` live under
  **`[defaults]`**, and it is **not** schema-validated. Profile files
  (`~/.coi/profiles/<name>/config.toml`) are **flat** top-level keys and *are* validated by
  `coi validate profile`. **Do not run `coi validate profile` against a main/project config** — wrong
  schema (it rejects `[defaults]`), and "fixing" it by hoisting a key to top level makes that key
  silently no-op at runtime. This is what broke auth for an afternoon.
- **Auth: use `env_commands`, not `forward_env`.** `forward_env` didn't deliver reliably.
  `env_commands` runs *in the VM* (Linux), so the Mac Keychain is unreachable — a mode-600 file is
  the equivalent. It's stripped from *untrusted project* configs, so it **must** be user-scope.
- **Night profile needs `[monitoring.nft] enabled = false`.** The nft monitor **hardcodes**
  auto-pause-on-high (ignores `auto_pause_on_high`), and "unauthorized connection attempt" fires HIGH
  on *any* non-allowlisted egress — so benign OS background traffic (Ubuntu/Canonical, esp.
  `unattended-upgrades`) freezes the run. Disabling the monitor **keeps the allowlist DROP rules in
  force** (network isolation ≠ the monitor daemon); process + filesystem monitoring stay on. The
  detector only arms in allowlist mode, so daytime `restricted` is unaffected.

## Ops notes

- **Resume.** An ephemeral container left Running (Claude exited without a clean teardown) does **not**
  produce a `--resume` session — that's saved only on graceful `coi shutdown`. The transcript lives at
  `/home/code/.claude/projects/-workspace/<id>.jsonl` inside the container; `incus file pull` it out,
  or relaunch in place:
  ```bash
  incus exec <container> -t --user 1000 --cwd /workspace \
    --env HOME=/home/code \
    --env CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.coi-claude-token)" \
    -- claude --continue --dangerously-skip-permissions
  ```
- **Permission mode is a launch flag, not stored in the session.** `claude --resume` alone runs in
  normal mode. Bypass comes from COI's `permission_mode` when COI launches the tool (`coi shell`), or
  by passing `--dangerously-skip-permissions` yourself (allowed only as the non-root uid-1000 user).
- **Idle noise.** `coi-default` is the "Docker" image → `dockerd` + `unattended-upgrades` run idle
  (`unattended-upgrades` is the night Canonical-pause trigger). Safe to disable for a leaner box.
- **Transient `tsc` crashes.** The native TS6/tsgo compiler can segfault under heavy concurrent load
  (chromium + vite + node + compiler) with **no** kernel OOM (Go alloc-fails fatally without tripping
  the OOM-killer). Not a code or toolchain bug — `tsc -b` runs clean in isolation. Reduce peak
  concurrency (close chromium after screenshots) if it recurs; don't chase it as a code defect.
- **Cleanup.** `coi kill <name>` / `coi clean` for stale ephemeral boxes.

## Deferred / to-do

Not blockers — the rig is fully operational without these. Polish, in rough priority order.

- **Lean the container: disable `dockerd` + `unattended-upgrades`.** `coi-default` is the "Docker"
  image, so both run idle; `unattended-upgrades` is the root cause of the night-pause we currently
  paper over with `[monitoring.nft] enabled=false`. Because the container is **ephemeral**, disabling
  them in a running box doesn't persist — bake it into a custom image (`[container.build]` layering on
  `coi-default`, same mechanism as chromium below) with something like:
  ```
  systemctl disable --now docker.service docker.socket unattended-upgrades || true
  ```
  Once done, the night profile could in principle re-enable the nft monitor (verify no other benign
  egress trips it first).
- **chromium in the image** — for in-container Playwright / the `run-app` visual skill. The only thing
  missing from `coi-default` for the full loop. Supported path is a **profile** with a
  `[container.build]` section on top of `coi-default` (never `COI_BUILD_SCRIPT_FROM_DISK=1` — that
  replaces COI's embedded security provisioning):
  ```toml
  [container]
  image = "coi-aperture"          # MUST differ from coi-default, else [container.build] is ignored
  [container.build]
  base = "coi-default"
  commands = ["apt-get update -qq", "apt-get install -y -qq chromium"]
  ```
  `coi build --profile <name>` publishes it; then point `[container] image` at `coi-aperture`. Defer
  until in-container visual iteration is actually wanted — it's a daytime-attended activity and
  lint/typecheck/test/build cover logic without it.
- **Verify nft network *alerting* on Mac.** Containment (allowlist DROP rules) is proven; whether the
  monitor *daemon* raises anomaly events on Mac is unconfirmed — we sidestepped it by disabling the
  monitor at night. To verify: in a daytime `restricted` shell, stream `coi audit -f` and trip a
  benign detector (e.g. a `grep -r secret /home/code` credential-scan pattern, or an egress to a
  non-allowlisted host); a WARNING/HIGH event means alerting works. If nothing fires, it's the
  "network monitoring degraded on macOS" case — accept containment-only, or set
  `[monitoring.nft] lima_host = "incus"` and retry.
- **Strip the dead `[defaults] forward_env` line from `.coi/config.toml`.** Auth moved to
  `env_commands` in the user config; the `forward_env` entry in the committed repo config is a no-op
  now. Confirm it's gone so the committed config carries zero cruft.
- **Explore `coi snapshot` (checkpoint / rollback).** Never exercised. Would let an unattended run
  checkpoint container state before a risky step and roll back on failure. Check the Snapshot
  Management wiki page for syntax; decide whether it's worth wiring into the night flow.

## Security posture

- **No AWS creds in either profile.** Default-deny means "do nothing" is already correct — never add
  them. Deploys are CI/OIDC; local `cdk deploy` is off-path.
- **No push to `main`/`dev`, ever.** Enforced by the harness (`.claude/hooks/gh-safety-guard.sh`)
  riding in via the workspace mount — fires in-container as long as `jq` is present (it is, in
  `coi-default`). Feature-branch pushes + `gh` PRs work daytime (restricted net reaches GitHub); the
  night allowlist omits GitHub, so an unattended run **structurally cannot push**.
- **One secret crosses in:** the OAuth token, revocable via `claude setup-token` / account settings.
  Nothing else is forwarded.
