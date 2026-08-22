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
Strict allowlist network, 10h hard cap.

**Keeping an unattended run alive — read this, the obvious answer is wrong.**
`caffeinate` blocks **idle** sleep only. It does **not** block lid-close sleep: closing the lid
forces sleep regardless of any assertion unless the Mac is in clamshell mode. So:

| Situation | What actually keeps it alive |
| --- | --- |
| Lid open, unattended | `caffeinate -s -- coi run ...` |
| Lid closed | **Clamshell mode** (external display + AC + input device), or **Amphetamine** with its closed-display option. `caffeinate` will not save you. |
| Any of the above | **On AC.** A flat battery hibernates the Mac and no assertion of any kind prevents that. |

Proof it isn't caffeinate's job: in the 2026-08-22 incident, powerd *released*
`"Prevent sleep while display is on"` at 09:11:35 and the machine slept at 09:11:40 — a
display-tied assertion cannot survive the display being closed. See
[Session lifecycle & failure modes](#session-lifecycle--failure-modes).

### Ending a session — do this, every time

```bash
# 1. ALWAYS. Exit the TUI cleanly so it restores your terminal.
Ctrl+D          # or /exit

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
session is written, **only** on a graceful `coi shutdown`. Skip it repeatedly and you accumulate
"ephemeral" containers holding GBs each (this rig once had four, one at 2.93 GiB).

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
- **Exit the TUI before you walk away — and `caffeinate` does not stop lid-close sleep.** Two
  separate traps, both cost hours once. Full evidence, log locations, ruled-out hypotheses and the
  correct shutdown ritual are in
  [Session lifecycle & failure modes](#session-lifecycle--failure-modes). Short version: a killed
  TUI leaves mouse reporting on in *your* terminal (`stty sane` won't fix it); a project `mounts:`
  change restarts the whole Lima VM and kills every container's session; `node_modules` is shared
  with the host so native binaries belong to whoever installed last.
- **Night profile needs `[monitoring.nft] enabled = false`.** The nft monitor **hardcodes**
  auto-pause-on-high (ignores `auto_pause_on_high`), and "unauthorized connection attempt" fires HIGH
  on *any* non-allowlisted egress — so benign OS background traffic (Ubuntu/Canonical, esp.
  `unattended-upgrades`) freezes the run. Disabling the monitor **keeps the allowlist DROP rules in
  force** (network isolation ≠ the monitor daemon); process + filesystem monitoring stay on. The
  detector only arms in allowlist mode, so daytime `restricted` is unaffected.

## Session lifecycle & failure modes

Written up after a 2026-08-21/22 debugging session that cost several hours. Everything here is
evidence-backed from logs; the dead ends are recorded deliberately so they aren't re-explored.
Applies to **any** COI project, not just Aperture.

### The invariant (this is the whole thing)

> **A full-screen TUI reconfigures *your local terminal*, and undoes that only on a clean exit.
> If it dies abruptly, your terminal keeps whatever modes it set.**

It has **nothing to do with whether Lima/Incus/the container are "running."** An idle VM and an idle
container are inert with respect to your terminal — they cost RAM and battery, nothing more.

The chain that makes this true:

```
claude (in container) → incus exec → Lima SSH/vsock → limactl → your iTerm
```

Claude runs *inside the container* but its stdout **is your iTerm window**. So:

1. On startup it sends your iTerm "report all mouse movement" — DECSET `1003` (any-event tracking)
   + `1006` (SGR encoding).
2. On a clean exit it sends the matching DECRST to turn that off.
3. An abrupt death (SIGHUP from a broken transport, SIGKILL, VM stopped underneath it, terminal
   force-quit) means **step 2 never runs**.
4. iTerm keeps reporting. Your shell receives mouse events as literal text.

The lid is only the most common trigger. The invariant is **abrupt death of an attached TUI**, not
sleep and not the VM.

### Symptom: your prompt fills with `35;97;27M`-style garbage

```
rr35;77;27M35;75;29M35;74;29M...
   ^^ ^^ ^^^
   |  |  └─ M = press/motion event
   |  └──── row
   └─────── column
```

`35` is the SGR button code for "motion, no buttons held" — i.e. every pixel of mouse movement was
typed for you. The `\e[<` prefix on each report is consumed by the terminal, leaving bare numbers.

**Nothing executes.** Mouse reports always terminate in `M`/`m`, never a newline — so the garbage
sits on the input line without running. Clear the line before typing.

**Fix, in order of preference:**

1. iTerm2 usually offers *"mouse reporting was left on … turn it off?"* — accept it. That is exactly
   the right fix and it only sends the DECRST sequences.
2. Manually: `printf '\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1015l'`
3. Or `reset` — heavier (clears screen, restores everything) but nothing to remember.

**`stty sane` does NOT fix this.** Mouse reporting is a mode in the terminal *emulator*, not the tty
line discipline, so `stty` cannot see it. This trips everyone.

### Triage: what actually died?

Two cheap signals, before touching any log:

- **`took 12h56m52s` on your shell prompt.** zsh only prints that when it regains control from a
  finished foreground command — so the process genuinely **exited**, it isn't merely suspended.
  Subtract the duration from the exit time to get the launch time.
- **A bare `%` on the line just before the prompt.** That's zsh's partial-line marker: the previous
  command's output didn't end in a newline. Signature of an abrupt stop, not a tidy shutdown.

Then one command splits the hypothesis space:

```bash
limactl shell incus -- sudo incus list
```

- **Container still `RUNNING`** → nothing stopped the container; only Claude died. Points at the
  transport (sleep, dropped connection).
- **Container `STOPPED`/gone** → something stopped it. Points at `max_duration`/`auto_stop`, the
  monitor, or a VM-level event.

### Where the logs are (full map)

**COI's own audit — check first, but know the limit:**
```bash
coi audit <container-name>        # bare `coi audit` errors: "no COI containers found for current workspace"
coi audit -f <container-name>     # follow
```
> ⚠️ **`coi audit` is LIVE-ONLY. There is no persisted audit history.** After the fact you cannot
> answer "did the nft monitor pause or kill it?" This is a real COI gap — see *Deferred / to-do*.

**On the Mac:**
```bash
ls ~/.lima/incus/
cat ~/.lima/incus/ha.stderr.log      # host agent: VM boot, SSH/vsock, port forwards
cat ~/.lima/incus/ha.stdout.log      # JSON status stream
tail -100 ~/.lima/incus/serialv.log  # VM console
pmset -g log | grep -E '<date> (08|09):'          # power events — the money log
pmset -g log | grep -iE 'sleep|wake|hibernate|low power'
pmset -g | grep -iE 'standby|hibernatemode'
log show --start '<t0>' --end '<t1>' --info --predicate 'process == "limactl"'
```
`ha.stderr.log` is **truncated when the VM restarts** — if the VM has come back since the incident,
that file only covers the new boot. Grab it early.

**Inside the Lima VM** (`limactl shell incus`):
```bash
sudo journalctl -u incus --since "yesterday" --no-pager
sudo journalctl -k | grep -iE "oom|killed process"        # OOM kill
sudo journalctl -k | grep -iE "suspend|resume|clocksource" # a big clock jump = VM was suspended
sudo incus info <container> --show-log
sudo sh -c 'ls -la /var/log/incus/'
sudo sh -c 'grep -iE "stop|shutdown|missing source" /var/log/incus/incusd.log*'
sudo sh -c 'zcat -f /var/log/incus/incusd.log* | grep -iE "<date> (08|09):"'
sudo sh -c 'cat /var/log/incus/<container>/*.log'
```

> **The `sudo` + glob trap.** `sudo grep … /var/log/incus/incusd.log*` fails with
> *"No such file or directory"* — because **your shell expands the glob as you**, before `sudo` runs,
> and `/var/log/incus/` is `drwx------ root`. The glob never expands and grep gets a literal `*`.
> Always wrap it: `sudo sh -c '… /path/*'`.

> **Absence of log entries ≠ nothing happened.** `incusd` only writes warnings/errors, so a quiet
> multi-hour session leaves no trace at all. `incusd.log` rotates at midnight; if the incident sits
> between a rotation and the next daemon start, there may be **no** incus-side record whatsoever.

### Incident 1 — 2026-08-21 20:10:49 — self-inflicted, a config change

```
20:10:49  ERROR  Failed stop validation for device  device=workspace
                 err="Missing source path \"/Users/…/psi-omega-website\" for disk \"workspace\""
          …same for .git/hooks, .git/config, and for EVERY other container (incl. aperture)…
20:10:49  dnsmasq: error binding DHCP socket to device incusbr0
20:10:49  systemd: Stopping incus.service
20:10:49  systemd: incus.service: Deactivated successfully
20:10:49  Consumed 30.443s CPU time over 30min 9.814s wall clock
          -- Boot de8edc0c… --                       ← VM rebooted
20:12:03  systemd: Starting incus.service
```

**Cause: applying a writable host mount for a project.** The mount is declared in that project's
`.coi/config.toml`:
```toml
mounts:
  - location: "~/Coding/Personal/WebDev/psi-omega-website"
    writable: true
```
…but for Incus to bind-mount a host path into a container, that path must first be visible **inside
the Lima VM**, which needs a Lima `mounts:` entry, which needs a **VM restart**. So:

> **A project-level mount change is a VM-level event. It kills every running Claude session in
> every container, across every project.** Do mount/config changes *before* starting a long run.

Diagnostic signature: mounts vanishing for **all** containers at the same instant, followed by an
**orderly** `Stopping incus.service`. Orderly shutdown ⇒ someone asked for it.

### Incident 2 — 2026-08-22 09:11:40 — the lid

```
09:11:35  Notification  Display is turned off
09:11:35  powerd Released PreventUserIdleSystemSleep "Powerd - Prevent sleep while display is on" 01:45:39
09:11:40  Sleep  Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:87%)
…
16:53:56  Wake from Deep Idle [CDNVA] : due to … lid … /UserActivity
```

**Arithmetic, exact to the second:**
```
20:14:48   coi run starts   (incus came back at 20:12:03 — relaunched ~2m45s later)
+ 12:56:52  ← the `took` figure zsh printed
= 09:11:40  Clamshell Sleep
```

The transport was torn down during the sleep transition, Claude got EOF and exited, zsh printed the
prompt — then the whole machine froze mid-frame. Seven hours later the lid opened and you were
looking at a prompt with mouse reporting still armed.

Supporting evidence:
- limactl unified-log activity runs normally until **09:07:00**, then stops.
- **No** `Stopping incus.service` between 20:12 (Aug 21) and 16:55 (Aug 22) → journald never flushed
  a shutdown record → abrupt, no cleanup. Contrast Incident 1, which logged one.
- 09:11:40 → 16:53:56 is ordinary `Maintenance Sleep` / `DarkWake from Deep Idle` cycling with RAM
  powered — **not** hibernation. The VM was paused, not destroyed.
- The VM cold-booting at **16:55:15** is not a second failure: `limactl shell` **auto-starts a
  stopped instance**, and that's what running it to investigate did.

### Ruled out — with the evidence, so nobody re-checks these

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| OOM kill | **No** | `sudo journalctl -k \| grep -iE "oom\|killed process"` → empty |
| `max_duration` / `auto_stop` | **No** | Not set on the daytime profile; container still `RUNNING` after |
| nft monitor auto-pause/kill | **Unprovable** | `auto_kill_on_critical=true` *was* live (daytime profile), but `coi audit` keeps no history. Container was `RUNNING` and auto-pause pauses rather than kills, so unlikely. |
| VM suspend/resume tearing the VM down | **No** | `journalctl -k \| grep clocksource` shows only fresh-boot lines — no clock jump |
| Aggressive standby config | **No — red herring** | see below |
| `caffeinate` would have prevented it | **No** | see below |

**The `standbydelay` red herring.** `HibernateStats hibmode=3 standbydelaylow=0 standbydelayhigh=0`
looks like "standby fires instantly." It is **boilerplate**: that exact line appears on every single
DarkWake going back more than a week. And `pmset -g` doesn't even expose `standbydelay` on this
machine — only `standby 1` and `hibernatemode 3`, both defaults. Apple Silicon doesn't use the old
Intel standby-delay timers. Don't build a theory on that field.

**Why `caffeinate` wouldn't have helped.** It blocks *idle* sleep. Lid close forces sleep regardless
unless in clamshell mode. The log shows powerd *releasing* the display-tied assertion 5 seconds
before sleep — a "prevent sleep while display is on" assertion cannot survive the display closing.
Use clamshell mode or Amphetamine's closed-display option instead.

### Third kill mechanism: a flat battery, which nothing prevents

```
2026-08-21 07:00:12  Sleep  'Low Power Sleep':TCPKeepAlive=inactive Using Batt (Charge:1%) 38305 secs
2026-08-21 17:38:37  Wake from Hibernate  : due to lid/UserActivity  Using AC (Charge:2%)
```

The battery hit **1%**, the Mac hibernated for 10.5 hours, and woke only once on AC. This is a real
genuine hibernation (unlike Incident 2) and **no assertion of any kind stops it** — not caffeinate,
not Amphetamine. **Unattended runs must be on AC.** Full stop.

### Container leak — the cost of skipping `coi shutdown`

Four "ephemeral" containers were alive simultaneously (`coi-d2220571-1/-2/-3`, `coi-88cded0c-1`);
`-3` alone held **2.93 GiB** and 205 processes. Not because anything crashed — because ephemeral
destroy (and the `--resume` session write) happen **only** on a graceful `coi shutdown`, and none of
these sessions got one.

```bash
sudo incus list
coi kill <name>            # or: coi clean
sudo incus delete --force <name>
```

Keep a container if you still want its transcript:
`/home/code/.claude/projects/-workspace/<id>.jsonl` (see *Ops notes → Resume*).

### Related: the shared `node_modules` hazard

`/workspace` is a **virtiofs host mount** and `node_modules` is **not** separately mounted
(`findmnt -no FSTYPE,SOURCE /workspace/node_modules` → nothing). So **the Mac and the container share
one `node_modules`.** Native binaries are platform-specific, so **whoever ran `pnpm install` last
wins**:

- Installed in the container → the Mac breaks:
  `Cannot find module '../lightningcss.darwin-arm64.node'`
- Installed on the Mac → the container breaks:
  `Cannot find module '../lightningcss.linux-arm64-gnu.node'`

`tsc` and `vitest` are unaffected (they never load it); **`vite dev` and `vite build` are**. Fix by
running `pnpm install` on whichever side you're about to use. The durable fix is
`supportedArchitectures` in `.npmrc` so both platforms' binaries land — deliberately **not** done,
because it's a repo-wide change (and CI download cost) for a local-setup problem.

Also: **`pnpm install` needs `CI=true` inside the container**, or it aborts with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when it wants to purge the modules dir.

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

- **Persisted audit log.** `coi audit` is live-only (`coi audit -f <name>`); there is no on-disk
  history, so after an incident you cannot answer "did the nft monitor pause or kill this run?".
  Worth filing upstream — it's the one question the current tooling makes unanswerable.

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
