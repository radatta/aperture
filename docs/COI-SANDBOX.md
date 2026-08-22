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

Bypass perms, restricted network, the Vite range mapped out, no runtime cap. `pnpm dev` inside binds
`6173` (not `5173` — see *Ports* below), and the host port is pinned to match, so
`http://localhost:6173` in your Mac browser is the same server.

**First command in a new container — check the pids headroom.** It's one line, and the failure it
catches (`SIGABRT (134)` on your second session) is silent about its own cause:

```bash
paste -d/ /sys/fs/cgroup/pids.{current,max}
# want .../2048 (what .coi/config.toml asks for). If it says .../300, the bump isn't taking — see below.
```

**Overnight (unattended):**

```bash
coi run --profile aperture-night -- claude --dangerously-skip-permissions -p "<task>"
```

Strict allowlist network, 10h hard cap.

**Keeping an unattended run alive — read this, the obvious answer is wrong.**
`caffeinate` blocks **idle** sleep only. It does **not** block lid-close sleep. Two further traps:
`caffeinate -s` asserts PreventSystemSleep **only on AC power** — on battery it is a no-op — and
"clamshell mode" here means *lid shut but machine awake* (external display + AC + input device),
which is the opposite of macOS's `'Clamshell Sleep'` log string (sleep *caused by* the lid shutting).
So:

| Situation            | What actually keeps it alive                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lid open, unattended | `caffeinate -s -- coi run ...`                                                                                                                                                                                                                                |
| Lid closed           | **Clamshell mode** (lid shut, machine awake — needs external display + AC + input device), or **Amphetamine**'s closed-display option, which on most Macs wants AC plus an external display or input device too. `caffeinate` will not save you. |
| Any of the above     | **On AC.** A flat battery hibernates the Mac and no assertion of any kind prevents that.                                                                                                                                                                  |

Why (reasoning, not log evidence — caffeinate wasn't running): in the 2026-08-22 incident powerd
released its own `"Prevent sleep while display is on"` assertion at 09:11:35 and the machine slept
at 09:11:40. Any assertion tied to the display cannot survive the display closing, and `caffeinate`
on battery asserts nothing at all. See
[COI-INCIDENTS.md → Incident B](COI-INCIDENTS.md#incident-b--a-13-hour-unattended-run-died-and-left-the-terminal-broken).

### Ending a session — do this, every time

```bash
# 1. ALWAYS: exit the TUI cleanly so it restores your terminal — press Ctrl+D (or type /exit)

# 2 and 3 are real commands:

# 2. Done with the project — destroys the ephemeral container AND saves the --resume session.
coi shutdown

# 3. Done for the day — frees the RAM/battery the Lima VM holds.
limactl stop incus
```

Step 1 is the one people skip, and it is the one that costs you. Claude Code is a full-screen TUI
that reconfigures **your local terminal**; it only undoes that on a clean exit. Kill it abruptly —
by sleeping the Mac, dropping the connection, or closing the window — and your terminal is left in
whatever modes it set. Step 1 costs nothing and eliminates that entire failure class.

Step 2 is worth more than it looks: ephemeral containers are destroyed, and a `--resume`-able
session is written, **only** on a graceful shutdown. Skip it repeatedly and you accumulate
"ephemeral" containers holding GBs each (this rig once had four, one at 2.93 GiB).

> ⚠️ **Verify the subcommand name against `coi --help` on your COI version** and pin it here like
> the Incus version at *One-time setup*. The rest of this doc uses `coi kill` / `coi clean`;
> `coi shutdown` is the graceful path referenced by *Ops notes → Resume* but has not been
> re-verified on COI 7.3. If it doesn't exist, the graceful path is whatever `coi --help` calls it —
> the *ritual* (exit TUI → tear down container → stop VM) is what matters, not the spelling.

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

## Ports

**Convention: the port number tells you whose server it is.** `5173+` is you, on the Mac. `6173+` is
a COI container. Picked in `app/vite.config.ts` off the container hostname (`coi-*`), so one repo does
the right thing on both sides with no flags and no env var to remember.

Two design choices make it work end to end.

**1. A range, not a single port.** Several Claude sessions often share one container, and Vite walks
upward when its base port is taken (`6173 → 6174 → …`). Container network namespaces are separate, so
two *containers* could both hold `6173` — the range exists for multiple servers inside **one** box.
`vite preview` deliberately shares the base and increments into the same range.

**2. Pin `host` == `container`, so the port you see inside is the port on the Mac.** `PortEntry`
takes an explicit `host` field — *"Exact host port to bind (omit for stable auto-allocation per
workspace/slot)"*. Omit it and COI assigns something unrelated (`6173` → `localhost:42100`), and then
the number carries no information and has to be looked up. Pin it and there is nothing to look up:

```toml
[[ports.map]]
name      = "vite"
container = 6173
host      = 6173
# ... vite1..vite10 → 6174..6183, host == container throughout
```

> Confirm the key spelling against your COI before trusting it:
> `coi schema profile | jq '.["$defs"].PortEntry.properties | keys'`

**The cost of pinning: host ports are one global namespace, so projects must not overlap.** Two
containers pinning `6173` means the second one's proxy device fails to bind. Because
`.coi/config.toml` is per-repo, give each project its own band:

| Project         | Band           |
| --------------- | -------------- |
| you, on the Mac | `5173–5183` |
| aperture        | `6173–6183` |
| next project    | `6273–6283` |

There is also a `ports` field for *identity-mapped* ports — a count, published host==container,
"allocated per workspace/slot". Fewer lines, but COI chooses the numbers, which defeats the
convention. Explicit entries are worth the verbosity.

### Reading the port back

With `host` pinned, `ss` inside the container is the whole answer:

```bash
ss -ltn | grep -oE ':(5|6)[12][78][0-9]' | tr -d ':' | sort -u
```

If a mapping is ever *not* pinned, the authoritative view is host-side — worth a shell function, since
this is the "what is Claude serving right now?" question:

```bash
for c in $(incus list -c n --format csv); do
  echo "== $c"; incus config device show "$c" 2>/dev/null | grep -E 'listen|connect'
done
```

> **`COI_PORT_<NAME>` appears only once `host` is pinned.** The schema says each entry is *"exposed to
> the session as `COI_PORT_<NAME>`"*. While `host` was auto-allocated, the live Claude process's own
> `/proc/<pid>/environ` held no `COI_*` variable at all — only the OAuth token — so the
> `COI_PORT_VITE=…` line COI writes into the generated `CLAUDE.md` preamble looked like prose rather
> than proof. With `host` pinned, all 11 are present and correct (verified 2026-08-22:
> `COI_PORT_VITE=6173` … `COI_PORT_VITE10=6183`). Read them back with
> `tr '\0' '\n' < /proc/<pid>/environ | grep COI_PORT` on the Claude pid — not from a subshell, which
> won't have inherited them. Still don't build on them: `app/vite.config.ts` derives its port from
> `hostname()`, which works identically on the Mac.

## Config files

Four files. Only the first lives in this repo; the rest are machine-local and never committed.

| File                                           | Scope                      | Purpose                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.coi/config.toml`                           | **repo (committed)** | Daytime posture:`coi-default` image, `permission_mode=bypass`, CPU/mem caps, `network.mode=restricted`, the Vite `6173–6183` port map (`host` pinned == `container`), monitoring on. Secret-free. |
| `~/.coi/config.toml`                         | user (trusted)             | Auth injection:`[defaults.env_commands]` `CLAUDE_CODE_OAUTH_TOKEN = "cat $HOME/.coi-claude-token"`.                                                                                                        |
| `~/.coi-claude-token`                        | user, mode 600             | The token itself. Never mounted into the workspace.                                                                                                                                                            |
| `~/.coi/profiles/aperture-night/config.toml` | user (trusted)             | Night deltas:`network.mode=allowlist` + `allowed_domains`, `limits.runtime.max_duration="10h"`, `auto_stop=true`, `[monitoring.nft] enabled=false`.                                                  |

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
- **Exit the TUI before you walk away — and `caffeinate` does not stop lid-close sleep.** Two
  separate traps, both cost hours once. Full evidence, log locations, ruled-out hypotheses and the
  correct shutdown ritual are in
  [COI-INCIDENTS.md → Incident B](COI-INCIDENTS.md#incident-b--a-13-hour-unattended-run-died-and-left-the-terminal-broken). Short version: a killed
  TUI leaves mouse reporting on in *your* terminal (`stty sane` won't fix it); a project `mounts:`
  change restarts the whole Lima VM and kills every container's session; `node_modules` is shared
  with the host so native binaries belong to whoever installed last.
- **Night profile needs `[monitoring.nft] enabled = false`.** The nft monitor **hardcodes**
  auto-pause-on-high (ignores `auto_pause_on_high`), and "unauthorized connection attempt" fires HIGH
  on *any* non-allowlisted egress — so benign OS background traffic (Ubuntu/Canonical, esp.
  `unattended-upgrades`) freezes the run. Disabling the monitor **keeps the allowlist DROP rules in
  force** (network isolation ≠ the monitor daemon); process + filesystem monitoring stay on. The
  detector only arms in allowlist mode, so daytime `restricted` is unaffected.

## Known failure modes (index)

Full forensics — timelines, log locations, ruled-out hypotheses, exact commands — live in
**[COI-INCIDENTS.md](COI-INCIDENTS.md)**. Signatures only, so you can recognise which one you have:

| Symptom                                                                                                             | Cause                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt fills with`35;97;27M…` garbage                                                                            | A killed TUI never restored your terminal's mouse-reporting mode                                                                                     | Exit Claude cleanly (`Ctrl+D`). To recover: accept iTerm's "turn it off" prompt, or `reset`. **`stty sane` does not work.**                                                                                                                                                                                                    |
| Long unattended run died ~when you shut the laptop                                                                  | `'Clamshell Sleep'` — lid close forces sleep; **`caffeinate` does not prevent it** (and on battery it does nothing at all)                | Lid open + AC +`caffeinate -s`; or clamshell mode / Amphetamine closed-display. Always on AC.                                                                                                                                                                                                                                            |
| `Session can't start — SIGABRT (134)` on a 2nd/3rd session                                                       | Container**pids cgroup** ceiling saturated (`limits.processes`), `clone()` → `EAGAIN`. **Not** memory, **not** a Claude bug | `paste -d/ /sys/fs/cgroup/pids.{current,max}` — if close, raise `max_processes` in `.coi/config.toml` (now `2048`, verified landing). Hot-patch: `incus config set <ctr> limits.processes 8192` on the **host**. **Always verify a fresh container reports the number you wrote** — `1024` silently didn't take, `2048` did, and the difference was never explained. |
| Every container loses its mounts at once, then the VM reboots                                                       | A host-mount config change: the path must be visible in the Lima VM first, so applying it restarts the VM and kills every session                    | Make mount changes**before** starting a long run                                                                                                                                                                                                                                                                                     |
| `vite dev`/`build`: `Cannot find module '../lightningcss.*.node'` (or a `@tailwindcss/oxide` binding error) | `node_modules` is shared with the macOS host; native binaries belong to whoever installed last                                                     | `pnpm install` on the side you're using (`CI=true` inside the container). Doesn't affect `tsc`/`vitest`.                                                                                                                                                                                                                           |
| Four "ephemeral" containers alive, GBs each                                                                         | Ephemeral destroy +`--resume` write happen only on a graceful shutdown                                                                             | Tear down properly when done — see*Run → Ending a session*                                                                                                                                                                                                                                                                             |

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
- **Transient `tsc` crashes.** `tsc -b` (native TS6/tsgo) has been seen to die with a Go runtime
  stack trace under heavy concurrent load (chromium + vite + node + compiler), then run clean in
  isolation immediately after. **What's verified:** it happened, it was transient, and a re-run
  passed. **What is _not_ verified:** the mechanism. An earlier version of this note asserted
  "segfault, no kernel OOM, Go alloc-fails fatally" — that was inference presented as fact and
  should not be trusted. If it recurs, capture the **head** of the output (the panic reason is the
  first line, not the tail) before theorising. Practically: reduce peak concurrency — don't run
  `pnpm test`, a dev server, and headless Chromium simultaneously on a 12 GiB / 6 CPU box — and
  don't chase it as a code defect.
- **Cleanup.** `coi kill <name>` / `coi clean` for stale ephemeral boxes.

## Deferred / to-do

- **`[limits.cpu] allowance = "80%"` isn't landing.** A container booted 2026-08-22 reports
  `cpu.max = max 100000` — no quota — while `memory.high` and `pids.max` both match the file. Same
  class as the `max_processes` miss that broke second sessions (fixed as of `54fbe95`, cause never
  confirmed), and now the last
  known instance of it. Nothing has been observed starving, so this is config correctness, not a live
  failure. Diagnosis commands:
  [COI-INCIDENTS.md → Incident A → *Verify it took*](COI-INCIDENTS.md#verify-it-took).
- **Persisted audit log.** `coi audit` is live-only (`coi audit -f <name>`); there is no on-disk
  history, so after an incident you cannot answer "did the nft monitor pause or kill this run?".
  Worth filing upstream — it's the one question the current tooling makes unanswerable.

Not blockers — the rig is fully operational without these. Polish, in rough priority order.

- **Build a `coi-aperture` image — lean box + chromium in one job.** These were two separate parked
  items; they're one image build, and the pids incident makes it worth doing. `coi-default` is the
  "Docker" image, so `dockerd` + `containerd` + `unattended-upgrades` + a pile of Ubuntu daemons run
  idle. Measured 2026-08-22: **66 idle tasks → 30** after trimming, with the toolchain unaffected —
  over half the box's pids budget was noise (full table: [COI-INCIDENTS.md](COI-INCIDENTS.md) →
  *Incident A → What's actually burning pids*). Because the container is **ephemeral**, doing it in a
  running box doesn't persist; it has to be baked. Supported path is a **profile** with a
  `[container.build]` section (never `COI_BUILD_SCRIPT_FROM_DISK=1` — that replaces COI's embedded
  security provisioning):

  ```toml
  [container]
  image = "coi-aperture"          # MUST differ from coi-default, else [container.build] is ignored
  [container.build]
  base = "coi-default"
  commands = [
    "systemctl disable --now docker.service docker.socket containerd.service unattended-upgrades.service udisks2.service rsyslog.service cron.service || true",
    "systemctl mask snapd.service snapd.socket snapd.seeded.service || true",
    "apt-get update -qq",
    "apt-get install -y -qq chromium",
  ]
  ```

  `coi build --profile <name>` publishes it; then point `[container] image` at `coi-aperture`.
  **`mask` snapd, don't `disable`** — `snapd.socket` is socket-activated, so one stray `snap` call
  wakes ~45 threads. Two knock-ons: chromium unlocks in-container Playwright / the `run-app` visual
  skill (the only thing missing from `coi-default` for the full loop), and dropping
  `unattended-upgrades` removes the night-pause trigger we currently paper over with
  `[monitoring.nft] enabled=false`, so the night profile could re-enable the monitor — verify no
  other benign egress trips it first.
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
