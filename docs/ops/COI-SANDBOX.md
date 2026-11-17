# Aperture on code-on-incus (COI) — sandbox runbook

Run Claude Code against this repo inside an **Incus system container** — as a day-to-day dev
environment _and_ an unattended overnight rig (`--dangerously-skip-permissions`). The container,
not Claude's own Bash sandbox, is the isolation boundary. Two profiles off one base config.

Posture, either profile: **code / test / build only — no local deploy, no AWS creds.** Deploys run
through CI on a branch push; local `cdk deploy` is off-path and the harness (`.claude/hooks`) blocks
pushes to `main`/`dev` regardless.

Built + verified on an Apple-silicon Mac, 2026-08-10/11.

---

## Rules that bite

Five rules that break a session otherwise, each with its home:

1. **Leave cleanly:** `Ctrl+D` (or `/exit`) leaves Claude Code, then `exit` leaves `coi shell` — that
   exit is the save (it exports the session). An abrupt kill leaves the local terminal with mouse
   reporting on (COI-INCIDENTS → _Symptom: your prompt fills with `35;97;27M`-style garbage_). To step
   away, detach and leave the container running; `coi shutdown` **deletes** the container — not part of
   a normal day (_Start here_ → 4).
2. **Unattended runs need AC power, and `caffeinate` is not enough** — the lid sleeps the Mac
   regardless, and a flat battery hibernates it. COI-INCIDENTS §B.2 (the lid) + _Third kill mechanism:
   a flat battery_; the lid-open / clamshell / Amphetamine options table is under _Run_ below.
3. **`node_modules` is shared with the host** — a native-binding error from `vite` usually means the
   other platform installed last, not a port clash. `CLAUDE.md` → Commands; COI-INCIDENTS → _Related:
   the shared `node_modules` hazard_.
4. **Ports are split by owner:** `5173+` is the Mac, `6173+` is a container (_Ports_ below).
5. **Some command text kills or pauses the container** — reverse-shell shapes and a slash right before
   `curl`/`wget`, anywhere in a Bash line or a Grep pattern, even inside a string; separately, a remote
   `:8080` connection.
   The list: `CLAUDE.md` → Commands; the mechanism: COI-INCIDENTS → Incidents F and H.

---

## Start here — the four things you ever do

You are always doing exactly one of these. There are three layers (Mac → Lima VM → container) and
almost every mistake is running a command at the wrong one.

**Container name for this repo is `coi-<hash>-1`** — the hash is derived from the workspace path,
so it's stable. `incus list` prints it; substitute it wherever this doc writes `coi-<hash>-1`.

### 1. Use Claude

```bash
# ── on the Mac ──  (<mac-repo>: the Mac repo path, in the gitignored .local/mac-root of the main checkout)
cd <mac-repo>
limactl shell incus                       # → you are now in the Lima VM

# ── in the VM ──  (prompt: <you>@lima-incus:...)
incus list                                # is the container still there and Running?

#   Running  → reattach. Claude is still alive in tmux; nothing restarts.
coi attach

#   Stopped  → start the same container again (same disk, same ~/.claude), then resume in it.
coi shell                                 # from the repo folder — v0.15 reuses a stopped persistent container
claude --resume                           # (in the container, from /workspace) pick your session

#   Gone     → rebuild it from the export, then pick your session in the container.
ls ~/.coi/ && ./scripts/coi-vm-setup.sh --check    # both pass 9/10 times → skip to the next line
coi shell --resume                        # → you are now in the container
claude --resume                           # (prompt: code@coi-<hash>-1) pick your session
```

**Reach for `coi attach` first — it is the normal case.** A persistent container is _kept running_
when you leave, so the `claude` process and its tmux session survive; `coi attach` is a
`tmux attach` — you land back in the same conversation, and nothing resumes (source references:
_Ending a session_).

**`coi shell --resume` is for when the container is gone**, after a `coi shutdown` or a VM rebuild.
It rebuilds from `~/.coi/sessions-claude/` and your transcripts, prompt history (`↑`), settings and
statusline all come back — verified 2026-09-07, see _Ending a session_. Bare `coi shell` is only for a
_stopped_ container (it restarts it, disk intact — 2026-10-13); on a torn-down container it gives you an
empty box, and on a running one v0.15 starts a second container instead.

**Every `coi shell --resume` forks the session** — a new session id, another `(N)` entry in the
`claude --resume` picker, and live forks fan one message out to all of them. Cleanup procedure and
evidence: [COI-INCIDENTS.md → Incident G](COI-INCIDENTS.md).

**If either check on the `ls ~/.coi/ && … --check` line fails**, you're on a fresh Mac or a rebuilt VM — go do
_One-time setup_ below (~20 min, mostly `coi build`), then come back. `ls ~/.coi/` failing means no
COI state at all; `coi-vm-setup.sh --check` failing means `~/.coi/` exists but isn't mirrored to Mac
disk, which quietly costs you sessions on the next VM rebuild.

> **Anything you configure inside the container, outside `~/.claude`, is gone on the next rebuild.**
> The export is exactly `~/.claude/` plus `metadata.json`; nothing else from `$HOME` is in there. So a
> `git config --global`, a `~/.bashrc` line, an `npm config set`, a `mise use --global`, an
> `apt-get install` — all of it evaporates the next time the container is recreated.
>
> Put durable config where it already lives on Mac disk. Two worked examples (evidence:
> [COI-INCIDENTS.md → Incident G.2](COI-INCIDENTS.md)):
>
> **Git identity.** The image ships `~/.gitconfig` with `useConfigOnly = true` and no name/email
> (deliberate — it stops an agent committing as `code@coi-<hash>-1`), so commits fail until you
> set one, and a `--global` fix inside the container dies with it. The fix is repo-local, run **on
> the Mac** (`.git/config` is a read-only mount inside the container):
>
> ```bash
> git config --local user.name  "<your-name>"
> git config --local user.email "<your-email>"
> ```
>
> `.git/config` lives on Mac disk and is mounted into every container, so there is nothing to
> restore, and it satisfies `useConfigOnly` properly rather than disabling it.
>
> **The toolchain.** `~/.config/mise/` and `~/.local/share/mise/` are on the rootfs. The image ships
> mise configured with `"npm:pnpm" = "latest"`, which is wrong for this repo twice over — it shadows
> corepack on `PATH`, and "latest" is a different major from the `packageManager` field CI reads.
> **pnpm's version belongs to the repo, not the machine** (`CLAUDE.md` → _Conventions_). The image
> ships the same conflict three times — `typescript` and `tsx` too. Undo it per container:
>
> ```bash
> # remove the `"npm:pnpm" = "latest"` line from ~/.config/mise/config.toml, then:
> /usr/local/bin/mise prune    # full path: mise is a shell function, absent in non-interactive shells
> sudo corepack enable         # ~/.local/bin is not on PATH here, so the no-sudo variant won't help
> command -v pnpm && pnpm -v   # expect /usr/bin/pnpm and the packageManager version
> /usr/local/bin/mise uninstall npm:typescript npm:tsx   # `prune` is NOT enough — it does not
>                                                        # uninstall tools dropped from config
> ```
>
> Bare `tsc` and `tsx` stop existing, which is the point — nothing should invoke them outside a
> project. If something needs to survive rebuilds, it belongs in the image (`[container.build]`, see
> _Deferred_) or on the repo mount — never in a container-local dotfile.

### 2. Debug at the VM layer

Container won't start, ports are wrong, `~/.coi/` looks off, a session didn't come back:

```bash
cd <mac-repo> && limactl shell incus

incus list                                # is the container there, and Running/Frozen/gone?
coi list
ls -lt ~/.coi/sessions-claude/            # what COI actually saved, newest first
grep '"level":"high"' ~/.coi/audit/coi-<hash>-1.jsonl    # threat pauses (`coi audit` under-reports)
coi unfreeze coi-<hash>-1                 # container stuck Frozen
```

**A session didn't come back — look at the export before resuming.** After `coi shutdown` and before
`coi shell --resume` the container is gone and nothing has been restored yet, which separates
_"COI never exported it"_ from _"COI exported it and the restore failed"_:

```bash
NEW=$(ls -t ~/.coi/sessions-claude/ | head -1)
ls -l  ~/.coi/sessions-claude/$NEW/.claude/projects/-workspace/   # transcripts present?
find   ~/.coi/sessions-claude/$NEW -type l -printf '%p -> %l\n'   # symlinks are NOT followed at export
```

Transcripts present → the export is fine. Absent, with a symlink showing → _One-time setup_ step 12.

**`coi` and `incus` only exist here.** Typing them inside the container is the single most common
wrong-layer mistake — they aren't on `PATH`, so the line echoes back mangled with no error worth
reading. One-line test either way: **`ls ~/.coi/` works → VM. Fails → container.**

#### Container frozen — find out what tripped it

Your terminal goes dead mid-session and you get:

```
*** SECURITY: Container coi-<hash>-1 PAUSED due to security threat.
    Unfreeze with: coi unfreeze coi-<hash>-1 ***
```

**Do not start with `coi audit`**: read-path defect — it returned empty for a fully populated log
(Incident E). `coi audit -f <name>` is live-follow only.

**Go straight to the file.** Complete per-poll telemetry — connections, processes, filesystem
rates, resource usage, every threat verdict — is written every ~2s for the container's whole
lifetime:

```bash
coi list                                          # exact name + confirm status Frozen
A=~/.coi/audit/coi-<hash>-1.jsonl                 # -nft.jsonl alongside it = network layer
grep '"level":"high"' "$A" | tail -5
```

Each verdict appears **twice** — once with `"action":"pending"`, then again as `"action":"paused"`.
Pretty-print the last one and read its `evidence` block:

```bash
grep '"level":"high"' "$A" | tail -1 | python3 -m json.tool
```

(A sample verdict is in [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md).)

**Name the process that did it — this is the step that ends most investigations.** The audit
record is not just the verdict: each poll embeds the container's whole `processes` list at that
timestamp. So you can read off the exact command:

```bash
# NOTE the second grep. Two record shapes match '"level":"high"': the full poll record
# (carries filesystem + processes + a threats[] array) and a standalone threat record
# (id / evidence / action, NO processes). Without it, tail -1 lands on the latter and
# prints nothing.
grep '"level":"high"' "$A" | grep '"processes"' | tail -1 | python3 - <<'PY'
import sys, json
d = json.load(sys.stdin)
for p in d.get("processes", {}).get("processes", []):
    print(p["pid"], p["command"][:120])
PY
```

Write volume per poll, to see a spike without waiting for a verdict:

```bash
tail -60 "$A" | python3 - <<'PY'
import sys, json
for l in sys.stdin:
    d = json.loads(l)
    fs = d.get("filesystem") or {}
    w = fs.get("total_write_mb", 0)
    if w > 5:
        print(d["timestamp"][11:19], "%8.1f MB  %8.1f MB/s" % (w, fs.get("write_rate_mb_per_sec", 0)))
PY
```

**Attribute before you theorise** — the process list names the real culprit (worked case:
[COI-INCIDENTS.md → Incident E → _Second freeze_](COI-INCIDENTS.md)).

**Triage — is it real?** Four checks, in this order:

| Check                                      | Benign                                                                                                 | Worth investigating                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `category`                                 | `filesystem`                                                                                           | `network` — an actual egress verdict          |
| The process list at that timestamp         | a build, install, or test you started (`pnpm install`, `vite build`, `tsc`)                            | nothing that explains the I/O                 |
| `files_read` (read verdicts)               | **`0`** — bulk read the monitor couldn't attribute to any file, i.e. interpreter/tool startup indexing | a real count, naming files it could attribute |
| New outbound connections at that timestamp | none; same steady-state HTTPS to the Anthropic API                                                     | anything new                                  |

All benign → false positive. Unfreeze and carry on:

```bash
coi unfreeze coi-<hash>-1
```

**A Bash line containing `/curl` or `/wget` pauses the container too** — Sigma's _Suspicious Download
and Execute Pattern via Curl/Wget_ wants `/curl`|`/wget` + `/tmp/`|`/dev/shm/` + `sh -c`, and the Bash
tool's wrapper supplies the last two on every call. Bare `curl` is fine; read `…/curl/…` paths with the
Read tool. The guard hook denies it ([Incident H](COI-INCIDENTS.md)). `[detection] sigma_dir =
"/nonexistent"` switches every Sigma rule off — a fallback, not the fix.

**Two exec-watcher shapes pause it as well** (`procwatcher.go:41-76`, matched on the started process's
own command line): a command starting with `nc` (`nc`, `ncat`, `nc.openbsd`…) whose text holds `-e`
_anywhere_ — a hostname like `db.us-east-1…` counts — and `node -e`/`-p` with both `child_process` and
`net`. Use `curl -sI` for reachability and put node scripts in a file. The Bash guard denies both.

**Two detectors, don't confuse them.** In `allowlist` mode (the night profile) _any_ non-allowlisted
egress fires HIGH — benign Ubuntu/Canonical background traffic trips it, which is the known-noisy
one and why the night profile sets `[monitoring.nft] enabled = false`. The startup freeze above is a
_different_ detector, `file_read_rate_mb_per_sec`, which arms in `restricted` mode too, so daytime
sessions get it as well.

**There is a _write_ detector too, and it is the one that will actually bite you** — `pnpm install`
freezes the container. Five things about it were read from COI's source (`d304121`, 2026-09-07) and
live in [COI-INCIDENTS.md → Incident E → _Second freeze_](COI-INCIDENTS.md). The operational
consequence: the `file_read_*` keys drive the write detector too, and the burst and rate thresholds
are one check, so you are really picking one number:

```
file_read_rate_mb_per_sec = <MB/s ceiling>
file_read_threshold_mb    = <ceiling> × poll_interval_sec
```

**Sizing — against observed load, not hardware maximums.** Peak here was 61 MB/s / 127 MB per poll,
for a 479 MB `node_modules`. Roughly 4x that:

```toml
[monitoring]
enabled               = true
poll_interval_sec     = 2
auto_pause_on_high    = true
auto_kill_on_critical = true

# These two drive BOTH the read and write detectors (detector.go:36-37 on v0.15 copies them into
# the write fields; there is no file_write_* key). rate is the real knob;
# threshold_mb must equal rate × poll_interval_sec or the lower one silently binds.
file_read_threshold_mb    = 500   # was 50 — burst, MB in one 2s poll
file_read_rate_mb_per_sec = 250   # was 10 — sustained ceiling, MB/s
```

A cold `docker build` may still trip this occasionally. That is the intended tradeoff, and the
process list in the verdict tells you why in one command.

A threshold above the container's real write ceiling is `enabled = false` with extra steps; measured
headroom here is 5–10x (Incident E → _Write ceiling_).

**Writes to `/workspace` are invisible to this detector.** It reads cgroup `io.stat` `wbytes` —
block I/O — and virtiofs writes happen on the Mac. So:

| Written to                                                            | Counts toward the threshold? |
| --------------------------------------------------------------------- | ---------------------------- |
| `/tmp`, `~`, container rootfs — temp files, Docker layers, `~/.cache` | **yes**                      |
| `/workspace/**` — the repo, `node_modules`, **and the pnpm store**    | **no**                       |

Measurements, the store-dir correction and the copies-not-hardlinks finding: Incident E →
_Writes to `/workspace` are invisible to this detector_.

**Confirming a config change reached the daemon.** The monitors run in a detached `coi supervise`
process that reads the config when the container starts and lives until it stops
(`cli/supervise.go:26-33,48-56`, v0.15) — a new `coi shell` or `coi attach` on a running container
keeps the old one. A change needs the container stopped (_Start here → 4_, step 3). Verify from the
detector's own output rather than by inspection — trip it deliberately and read the threshold back:

```bash
dd if=/dev/zero of=/tmp/big bs=1M count=2000 conv=fdatasync; rm -f /tmp/big   # will freeze you
grep '"level":"high"' "$A" | tail -1
```

The verdict echoes the new number (still `50` would mean the edit hadn't landed); the 2026-09-07
readback is in Incident E → _Config-change readback_. Then `coi unfreeze <name>`.

**Keep `auto_pause_on_high = true`** — `internal/monitor/responder.go:131-147` (v0.15) shows turning it off
disarms auto-pause for **network** HIGH threats too — unexpected outbound connections, the ones
actually worth freezing on. Raise the thresholds instead; that is the targeted fix.

**Levers that do not exist:** no zero-to-disable, no process/path exemption, no per-category switch,
no env/CLI override, and `[limits.disk]` is a throttle, not the detector — the checked list is
Incident E → _Levers that do not exist_. Since v0.14 there are three narrow exceptions:
`[monitoring] reverse_shell_one_liners` (one class), `[detection] sigma_dir`/`gtfobins_dir` (a
nonexistent dir disables that source), and `[[network.hosts]]` destinations, which the network checks
now exempt.

After `coi unfreeze`, further HIGH threats — network ones included — are only logged: `r.paused` is
never reset (`responder.go:182-218`), and on v0.15 the responder lives until the container stops, so
that is the container's whole life (_inference_ — no reset code). A stop re-arms it. Fix the config.

Full reasoning: [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md).

#### Container _killed_ — the CRITICAL path is a different animal

A freeze is the polite failure; CRITICAL kills the container, and a repeated shape kills the next
container too (mechanism: [COI-INCIDENTS.md → Incident F](COI-INCIDENTS.md)). What triggers it in practice is not
an attack but a **hardcoded** pattern list (`internal/monitor/process.go:269-330`, v0.15 — matched
lowercased and token-anchored, so `ssh -i` or `rsync -e` don't count). Rule reference, regenerated on
every COI upgrade: `localNotes/code-on-incus/APERTURE-ANALYSIS.md` (gitignored, local).

```
strong — CRITICAL in any process, no gate:
  bash -i  sh -i  (and zsh ksh dash ash fish csh tcsh mksh oksh lksh posh yash rbash with -i)
  nc -e  ncat -e  nc.traditional -e  nc.openbsd -e
  socket.socket  fsockopen  System.Net.Sockets  ruby -rsocket  perl -MIO / -MIO::Socket
  socat / powershell  + a network token        EXEC: / SYSTEM:  on a socat line
  /dev/tcp/<host>/…  /dev/udp/<host>/…  in a shell process, non-loopback endpoint
one-liner class — only with a network token:
  python -c  python3 -c  perl -e  php -r  ruby -e
```

A network token (`process.go:500-508`) is `tcp`, `udp`, `socket`, `fsockopen`, `sockaddr`, a
whitespace-delimited IP, or a non-loopback `host:port` — anywhere on the same command line, and the
Bash wrapper is one command line. Until v0.14 any `:` satisfied it (Incident F). **Grep is exposed
too:** its `rg` argv is a command line, so a pattern carrying a strong token kills (`/dev/tcp/` and the
`/curl` pause shouldn't fire there — _inference_: `rg` is spawned without a shell, so no `sh -c`).

**The fix is not `auto_kill_on_critical = false`** — that flag is the sandbox's actual purpose. The
list is compiled in, but `[monitoring] reverse_shell_one_liners = "warn"` (set in `.coi/config.toml`)
downgrades the one-liner class to audit-only. Otherwise stop emitting the shape:

| Instead of                                                                     | Use                                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `python3 -c '…'` on a line that also mentions tcp/udp/socket/an IP/`host:port` | `python3 - <<'PY' … PY` — runs as `python3 -`, not on the list                                |
| any JSON one-liner                                                             | `jq`, which is installed and matches nothing (plain `python3 -c "print(1)"` is safe on v0.15) |
| `bash -i -c '…'`                                                               | run the command directly                                                                      |
| searching for a flagged token (Bash or Grep)                                   | an escape or fragment: `socket\.sock`, `bash\s-i`, `fsock[o]pen`                              |

`.claude/hooks/coi-reverse-shell-guard.sh` (Bash) and `coi-grep-guard.sh` (Grep) deny these at
`PreToolUse`, sharing their rules through `_coi-patterns.sh`. They no-op outside a `coi-*` host, and
they match the **text anywhere in the command** — so a heredoc whose content carries a strong token is
blocked too: use the Write/Edit tools for file content. They are narrowed to what v0.15 really fires
on, because over-blocking makes Claude timid. The Bash guard also runs on the Monitor tool, whose
`command` is a shell line too.

**After a kill, a copy may survive.** `[monitoring] forensics_on_kill = true` (set in
`.coi/config.toml`) makes COI `incus copy` the container before its delete (`responder.go:243-262`,
at most 3 copies, `:333`). The copy is stopped and holds the killed container's whole disk — including
`~/.claude`, so the session transcript is recoverable with `incus file pull` (on the VM). On our `dir`
pool each copy is a full rootfs copy, not a reflink: it costs tens of seconds and a few GB, and COI
never deletes it — find it with `incus list` and `incus delete` it once recovered (the copy's exact
name isn't verified here).

Full write-up: [COI-INCIDENTS.md → Incident F](COI-INCIDENTS.md).

### 3. Debug inside the container, without Claude

A shell in the box, bypassing COI entirely — the right tool when `coi shell` itself is what's
misbehaving:

```bash
# from the VM
incus exec coi-<hash>-1 -t --user 1000 --cwd /workspace --env HOME=/home/code -- bash
```

Then the usual: `paste -d/ /sys/fs/cgroup/pids.{current,max}` (want `.../4096`),
`ls ~/.claude/projects/-workspace/`, `df -h`, `mount | grep workspace`.

To relaunch Claude this way instead of `bash`, add the token env var — see _Ops notes → Resume_.

### 4. Done for now

```bash
# ── in the container ──
# 1. Ctrl+D (or /exit)  — leaves Claude Code. You are still in a container shell.
# 2. exit               — leaves `coi shell`. THIS is what exports your session.
#    The container stays running; come back later with `coi attach` (see §1).

# ── in the VM ──  to apply a .coi/config.toml change and KEEP the container (v0.15; done 2026-10-13):
# 3. after step 2, stop it, then start it again from the repo folder. `coi shell` reuses a STOPPED
#    persistent container (a running one gets a second container instead). The stop exports nothing;
#    the container's disk keeps ~/.claude. cpu/memory seem applied only when a container is created (unverified),
#    so set them on the stopped one too (processes as well — re-applying it on reuse isn't verified).
#    Then, inside, `claude --resume` from /workspace for each session.
coi container stop coi-<hash>-1
incus config set coi-<hash>-1 limits.cpu=N limits.memory=NGiB limits.processes=N   # only if [limits] changed
cd <mac-repo> && coi shell

# ── in the VM ──  ONLY when you actually want the container GONE — reclaiming disk, a broken box.
# 4. coi shutdown — exports nothing itself; run it only after step 2.
coi shutdown coi-<hash>-1                 # DELETES the container, persistent ones included. Name
                                          # REQUIRED (or --all). `coi close` is an alias. --force skips the prompt.

# ── on the Mac ──  (only if you're done for the day — frees the VM's RAM/battery)
# 5.
limactl stop incus
```

**Steps 1 and 2 are the whole routine.** `coi shutdown` is not part of a normal day: it destroys the
container, forcing a `--resume` next time, which **forks the session** (§1). Leave it running and
reattach.

**Stepping away without ending? DETACH, don't exit.** If you run your own tmux around the session,
`Ctrl+B` then `D` detaches it (the container's own tmux: `Ctrl+A`, _tmux_ below) — Claude Code, `coi shell`,
every pane and the container stay alive; reattach later with `tmux attach` (or `coi attach`). Nothing exits,
nothing forks. This is the routine nightly move: the `exit` in step 2 _closes_ the pane you'd detach from.
The tradeoff: a detach does **not** end `coi shell`, so **no fresh export snapshot is written** — you're relying on
the container surviving. Before anything risky (a VM change, a Mac reboot), run the step-1/2 exit
first to force a snapshot, then come back with `coi attach` (the container is still running — `coi
shell --resume` against a running one isn't re-checked on v0.15 and may start a second container).
_(The no-snapshot-on-detach
point is inferred from the export firing on `coi shell` exit, not raced empirically; the
export-on-exit mechanism itself is verified — see *Ending a session*.)_

**Exiting `coi shell` is the save. `coi shutdown` is the delete.** Two different programs, two
different jobs — this doc had it backwards until 2026-09-07. Mechanism and source references:
_Run → Ending a session_.

**Don't run `coi shutdown` while Claude Code is still up** — it races the teardown's save and leaves
your terminal broken; see _Ending a session_.

---

## Stack

```
Mac  →  raw Lima VM (name: incus)  →  Incus 7.4 (LXC) system container  →  Claude Code
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
# in the Lima VM — `coi` does not exist on the Mac or in the container (see *Start here*)
cd <mac-repo> && coi attach            # container Running — the normal case
cd <mac-repo> && coi shell             # container Stopped — restarts it, disk intact
cd <mac-repo> && coi shell --resume    # container gone
```

Bypass perms, restricted network, the Vite range mapped out, no runtime cap. `pnpm dev` inside binds
`6173` (not `5173` — see _Ports_ below), and the host port is pinned to match, so
`http://localhost:6173` in your Mac browser is the same server.

`coi attach` when the container is running; bare `coi shell` when it is stopped; `coi shell --resume`
when it is gone (it rebuilds a destroyed container from its exported session — but it resumes rather
than attaches, which forks the session; _Start here → 1_). On a running container a plain `coi shell`
starts a second one on v0.15 (`Auto-allocated slot 2`, failing on the pinned Vite port — seen
2026-10-13); `--resume` was a no-op there on v0.12, not re-checked on v0.15.

**First command in a new container — check the pids headroom.** It's one line, and the failure it
catches (`SIGABRT (134)` on your second session) is silent about its own cause:

```bash
paste -d/ /sys/fs/cgroup/pids.{current,max}
# want .../4096 (what .coi/config.toml asks for). If it says .../300, the bump isn't taking — see below.
```

**Overnight (unattended):**

```bash
coi run --profile aperture-night -- claude --dangerously-skip-permissions -p "<task>"
```

Strict allowlist network, 10h hard cap.

**Keeping an unattended run alive — read this, the obvious answer is wrong.**
`caffeinate` blocks **idle** sleep only. It does **not** block lid-close sleep. Two further traps:
`caffeinate -s` asserts PreventSystemSleep **only on AC power** — on battery it is a no-op — and
"clamshell mode" here means _lid shut but machine awake_ (external display + AC + input device),
which is the opposite of macOS's `'Clamshell Sleep'` log string (sleep _caused by_ the lid shutting).
So:

| Situation            | What actually keeps it alive                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lid open, unattended | `caffeinate -s -- coi run ...`                                                                                                                                                                                                                   |
| Lid closed           | **Clamshell mode** (lid shut, machine awake — needs external display + AC + input device), or **Amphetamine**'s closed-display option, which on most Macs wants AC plus an external display or input device too. `caffeinate` will not save you. |
| Any of the above     | **On AC.** A flat battery hibernates the Mac and no assertion of any kind prevents that.                                                                                                                                                         |

Why (reasoning, not log evidence — caffeinate wasn't running): a display-tied assertion cannot
survive the display closing, and `caffeinate` on battery asserts nothing at all — the 2026-08-22
log lines are in
[COI-INCIDENTS.md → Incident B](COI-INCIDENTS.md#incident-b--a-13-hour-unattended-run-died-and-left-the-terminal-broken) (B.2).

### Ending a session — do this, every time

Commands: _Start here → 4_. What each step does, and why:

Step 1 (`Ctrl+D`) costs nothing and eliminates a whole failure class: a full-screen TUI only
restores your local terminal on a clean exit —
[COI-INCIDENTS.md → Incident B → _The invariant_](COI-INCIDENTS.md#incident-b--a-13-hour-unattended-run-died-and-left-the-terminal-broken).

**Step 2 is the one that protects your data, and it is the step people don't know exists.** `Ctrl+D`
leaves _Claude Code_; you are still inside the container with `coi shell` running, and nothing has
been exported yet. The `exit` in step 2 ends `coi shell`, and its teardown
(`internal/cli/phases_shell.go:443-466`, `SaveSession: true`) is what writes
`~/.coi/sessions-claude/<id>/` — it builds `session.CleanupOptions{SaveSession: true, SessionsDir: …}`
and calls `session.Cleanup`, and runs whenever that `coi shell` process ends: a full snapshot on
**every normal exit**.

**After step 2 the container is still running — come back with `coi attach`, not `coi shell`.**
Persistent containers are kept alive on exit (`internal/session/cleanup.go:305-315` prints "use
'coi attach' to reconnect"), and `coi attach` is `tmux attach -t <session>` (`internal/cli/attach.go:160`), so
you rejoin the _same_ live `claude` process. Nothing resumes, and nothing forks. Using
`coi shell --resume` here instead would mint a new session id and another `(N)` entry in your
picker — see _Start here → 1_.

Step 3 picks up a `.coi/config.toml` change and keeps the container: `coi container stop` stops it and
removes its firewall rules, and `coi shell` restarts a _stopped_ persistent container
(`session/setup_phase_reuse.go`; `naming.go` `FindReusablePersistentSlot` skips running ones) and
re-applies isolation. Neither step exports — the container's disk keeps `~/.claude`.

Step 4 is optional and does **not** export — `internal/cli/shutdown.go` is stop → firewall cleanup →
`mgr.Delete(true)`, with no save call in it (grep it for `SaveSession`, `Cleanup`,
`saveSessionData`, `SessionsDir`: no hits). Run it to reclaim disk. Skipping it repeatedly is how you accumulate containers holding GBs each (this rig once had four,
one at 2.93 GiB — [Incident B → _Container leak_](COI-INCIDENTS.md)).

**Don't run `coi shutdown` while Claude Code is still up.** It turns the export into a race you do
not control: the dying container ends `coi shell`, whose teardown starts saving
("Save session data immediately — no pre-delay", `internal/session/cleanup.go:243`), while
`coi shutdown` proceeds to `Delete`. `cleanup.go` does handle a mid-shutdown race — on an SFTP error
it waits for the container to fully stop and retries via incus direct file access — but **that
fallback still needs the container to exist**, and `Delete` removes it. _(Inference from the code
ordering; not raced empirically. It went our way on 2026-09-07.)_ You also lose the in-flight turn,
and your terminal keeps whatever modes the TUI set — the `35;97;27M…` garbage, fixed with `reset`,
never `stty sane`.

> **Nothing is exported until `coi shell` exits**, and there is **no continuous backup**: everything
> since your last exit lives only inside the container. Exit properly at every real break, not just
> at the end of the day. The export _is_ a restore — `coi shell --resume` reads the whole `~/.claude`
> tree back into a fresh container, settled 2026-09-07 (an earlier version of this doc said the
> opposite). The evidence, the two things the restore does not carry, and what `persistent = true`
> does and doesn't buy: [COI-INCIDENTS.md → Incident D → _Fix_ → _Correction, 2026-09-07_](COI-INCIDENTS.md)
> and its _Open follow-ups_. Alive / deleted is not the whole set of container states — check
> `uptime -p` before calling a container new.

> **`coi shutdown` verified 2026-09-06** (the rig is COI v0.15.0 as of 2026-10-13, on Incus 7.4 as of 2026-09-26; "COI
> 7.4" in older notes was the Incus version) — it exists; it deletes, and exports nothing (above). On
> another COI version, check `coi --help`: the _ritual_ (exit TUI → tear down container
> → stop VM) is what matters, not the spelling.

## One-time setup

**Fresh Mac → working `coi shell`, in order.** Every step here fixed a real failure; none are
optional. Steps 1–2 are on the Mac, 3–11 inside the Lima VM (`limactl shell incus`); step 12 is
retained only as a do-not-do note. Budget ~20 minutes, most of it `coi build`.

This is also the **rebuild procedure**, reconstructed the hard way after a `limactl edit` typo wiped
the VM ([COI-INCIDENTS.md → Incident D](COI-INCIDENTS.md)). Before that, this section jumped from
"Incus required" straight to `coi shell` and could not actually get you there.

### On the Mac

1. **Scope the Lima mount to the repo, writable.** Lima mounts the Mac home **read-only**
   (`virtiofs ro`) by default, so the container workspace is read-only — and if `location` is left
   at `~`, the container sees your **entire home directory**, `.ssh` and `.aws` included. Fix both
   with `limactl edit incus`:

   <!-- prettier-ignore -->
   ```yaml
   mounts:
   - location: "<mac-repo>"
     writable: true
   ```

   > **Get the indentation right.** `writable` belongs _under_ `location`, no dash. A stray `-`
   > makes it `mounts[1]` — a second entry with no path — and Lima rejects the buffer with
   > `field 'mounts[1].location' must be an absolute path, got '.'`. Recovering from that rejection
   > is what destroyed this VM once already (Incident D). Mount changes also restart the VM
   > (Incident B.1), so make them **before** starting a long run, never during one.

   virtiofs perf is fine (~30s cold `pnpm install`).

2. **Auth token.** `claude setup-token` mints a ~1-year subscription OAuth token. Store it in a
   mode-600 file — **not** an env var in a committed config, **not** a wholesale `~/.claude` mount
   (COI warns that clobbers its own credential injection):

   ```bash
   claude setup-token                          # copy the token
   umask 077 && printf %s "<token>" > ~/.coi-claude-token
   ```

   Wire it in the **user-scope** COI config (below) via `env_commands`.

### In the Lima VM (`limactl shell incus`)

3. **Incus ≥ 6.1** (idmapping support). Ubuntu ships 6.0.5; older Incus fails container launch with
   an idmap error. Zabbly `stable` tracks the latest feature release:

   ```bash
   curl -fsSL https://pkgs.zabbly.com/get/incus-stable | sudo sh
   incus version        # pin what you got here — this rig has run 7.3 and 7.4 (7.4 as of 2026-09-26)
   ```

4. **Group membership.**

   ```bash
   sudo usermod -aG incus-admin $USER
   newgrp incus-admin && groups
   ```

   > `newgrp` in an already-open shell can fail to propagate to processes spawned later — so
   > `groups` says `incus-admin` while `coi health` still warns about permissions. If that happens,
   > `limactl stop incus && limactl start incus && limactl shell incus` for a clean re-login.

5. **`sudo incus admin init`** — storage pool + network bridge. A fresh install has **neither**, and
   everything downstream fails with cryptic errors (`Failed getting root disk: No root device could
be found`) until this runs.

   | Prompt                  | Answer                         | Why                                                                                                                                                                                                                                                                         |
   | ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Clustering?             | no                             | single-node                                                                                                                                                                                                                                                                 |
   | New storage pool?       | yes → `default`                | required                                                                                                                                                                                                                                                                    |
   | Backend                 | `dir`                          | `zfs` triggers a DKMS kernel-module compile on first use — multi-minute and CPU-bound. `dir` is near-instant. Tradeoff: `dir` re-unpacks the image every launch and forgoes `coi snapshot`; `coi health` will warn about it forever. Revisit deliberately, not mid-rebuild. |
   | Location                | default                        |                                                                                                                                                                                                                                                                             |
   | New bridge?             | yes → `incusbr0`               |                                                                                                                                                                                                                                                                             |
   | IPv4                    | `10.66.66.1/24` — **explicit** | see below                                                                                                                                                                                                                                                                   |
   | NAT IPv4                | yes                            |                                                                                                                                                                                                                                                                             |
   | IPv6                    | none                           | not needed                                                                                                                                                                                                                                                                  |
   | Available over network? | no                             |                                                                                                                                                                                                                                                                             |
   | Auto-update images?     | yes                            |                                                                                                                                                                                                                                                                             |
   | Print YAML preseed?     | **yes**                        | save it — `incus admin init --preseed < file.yaml` turns this whole table into one command next time. (Skipped during the real rebuild; still an open follow-up.)                                                                                                           |

   > **Don't bother with `--auto`.** It fails at subnet detection —
   > `Failed to automatically find an unused IPv4 subnet, manual configuration required` — even
   > when `ip addr`/`ip route` show only Lima's own `192.168.5.0/24` in use. Never diagnosed.
   > Specifying the subnet explicitly works; don't burn time here.

6. **Delegate host UID 501 to Incus.** Launch otherwise fails _"UID namespace isolation not
   supported"_. Confirmed entirely absent on a fresh VM:

   ```bash
   echo 'root:501:1' | sudo tee -a /etc/subuid
   echo 'root:501:1' | sudo tee -a /etc/subgid
   sudo systemctl restart incus
   ```

   (501 = the Mac user's uid; the container's `code` user is uid 1000, mapped `both 501 1000`.)

7. **Verify the daemon before building anything.**

   ```bash
   incus list                  # clean empty table, no error
   incus network list          # incusbr0, bridge, MANAGED yes, 10.66.66.1/24
   incus storage list          # default, DRIVER dir
   incus profile show default  # root disk (pool: default) + eth0 nic (network: incusbr0)
   ```

8. **Install `coi`, then build the image.**

   ```bash
   curl -fsSL https://raw.githubusercontent.com/coipond/coi/master/install.sh | bash
   coi build
   ```

   `coi build` takes 5–10 min cold — Ubuntu rootfs pull, Node 22, mise, pnpm, Docker, gh. **It is
   not hanging**; `incus list` shows the `coi-build` container running throughout. Expect this, and
   don't kill it:

   ```
   Warning: could not ensure bridge forwarding rules: could not determine bridge name...
   Added iptables FORWARD rules for incusbr0 (was missing — containers could not get IPs)
   Warning: could not get container IP for nft rules: timeout waiting for container IP after 30 seconds
   No IPv4 after 10s — injecting netplan DHCP config for cloud image...
   Network ready (HTTP) after 1 seconds
   ```

   That's `coi` self-healing a fresh-bridge race — missing FORWARD rules, then a netplan DHCP
   fallback. No intervention needed.

9. **`coi health`, and clear what it flags.**

   - permissions / group not reloaded → step 4's gotcha
   - `libsystemd-dev` missing → `sudo apt install -y libsystemd-dev`. Not cosmetic: it blocks the
     real-time nft threat-monitoring component that `.coi/config.toml` enables.
   - `dir` re-unpacks the image every launch → the accepted tradeoff from step 5.

   _36 checks passed with 2 warnings_ is the known-good end state for this rig.

10. **Make COI's own state durable (VM half) — don't skip this one.** `~` in the Lima VM is
    `/home/<user>.guest`, **VM-local**; the Mac is reachable only at `/Users/<you>/…`, and only
    through `mounts:`. So a VM rebuild takes everything in `~/.coi/` — your `coi` profiles, and every
    session the `coi shell` teardown exported to `~/.coi/sessions-claude/<id>/`, which is exactly
    the store `coi shell --resume` restores a destroyed container from. That has already cost
    sessions `94ef8ba6` and `12279d4a` and the `aperture-night` profile
    ([Incident D](COI-INCIDENTS.md)).

    ```bash
    <mac-repo>/scripts/coi-vm-setup.sh
    ```

    Symlinks `~/.coi/sessions-claude` and `~/.coi/profiles` into `localNotes/coi-state/` on the repo
    mount, so COI's own restore survives a rebuild. Idempotent, migrates existing content rather than
    replacing it, refuses rather than clobbering anything unexpected. **Deliberately not a
    `lima.yaml` edit** — mount changes restart the VM, and a typo in one is what caused the rebuild
    in the first place. Verify any time with `scripts/coi-vm-setup.sh --check` (exit 1 if the links
    are gone). It only mirrors what the teardown exports; nothing is written between exits (_Run →
    Ending a session_). Open question — whether `coi` recreates those paths with `mkdir -p` (a
    symlink survives) or replaces them outright: [Incident D → _Open follow-ups_](COI-INCIDENTS.md).

11. **First shell, trust, and verify the scoping.**

    ```bash
    cd <mac-repo> && coi shell
    ```

    On a fresh `~/.coi/`, the repo's port declarations are untrusted — COI treats a repo declaring
    host listeners as something you must approve, since it could otherwise squat local ports:

    ```
    [setup] Warning: ignoring untrusted port "vite" (container:6173) from .../.coi/config.toml
      (a repo declaring host listeners can squat localhost ports; run 'coi trust' or set COI_TRUST_ALL=1)
    ```

    `coi trust` clears it. Then confirm the mount is scoped the way step 1 intended — this is the
    check that caught the full-home mount, so run it every rebuild:

    ```bash
    ls /workspace            # Aperture files only — no .ssh, .aws, Desktop, Documents
    mount | grep workspace
    paste -d/ /sys/fs/cgroup/pids.{current,max}   # want .../4096 — see Incident A
    ```

12. **~~Make the transcript durable (container half).~~ Removed 2026-09-07 — do not do this.**

    This step ran `scripts/coi-container-setup.sh`, which symlinked `~/.claude/projects` onto the
    repo mount so Claude Code appended the transcript straight to Mac disk. The script has been
    deleted.

    It was built to cover "nothing is exported unless `coi` runs its graceful teardown" — but it
    **caused** the problem it was believed to be solving: COI does not follow that symlink at export
    time. Removing it was the whole fix — [Incident D → _Fix_ → _Correction, 2026-09-07_](COI-INCIDENTS.md).

    **Is this container affected?** `ls -ld ~/.claude/projects` showing an arrow into `/workspace`
    is the obvious case, but a bind mount looks exactly like a real directory. Compare filesystems —
    two different numbers means the transcript is container-local and you're clean:

    ```bash
    stat -c %d ~/.claude/projects   # want 64769 — /dev/vda1, the container rootfs
    stat -c %d /workspace           # want 45    — virtiofs, the Mac
    ```

    If it is affected, remove the symlink or `--resume` will keep coming up empty:

    ```bash
    # exit Claude Code first, then from the container shell.
    # NOTE: ~/.claude/projects IS the symlink here, so don't "back up" through it — src would
    # equal dst. Snapshot the real directory instead:
    cp -a /workspace/localNotes/coi-state/container/projects \
          /workspace/localNotes/coi-state/container/projects.bak-$(date +%F)

    unlink ~/.claude/projects
    cp -a /workspace/localNotes/coi-state/container/projects ~/.claude/projects
    ```

    Old transcripts written through that symlink are still on Mac disk at
    `localNotes/coi-state/container/projects/-workspace/` and can be copied into
    `~/.claude/projects/-workspace/` at any time — `claude --resume` picks up whatever is in that
    directory.

## Ports

**Convention: the port number tells you whose server it is.** `5173+` is you, on the Mac. `6173+` is
a COI container. Picked in `app/vite.config.ts` off the container hostname (`coi-*`), so one repo does
the right thing on both sides with no flags and no env var to remember.

Two design choices make it work end to end.

**1. A range, not a single port.** Several Claude sessions often share one container, and Vite walks
upward when its base port is taken (`6173 → 6174 → …`). Container network namespaces are separate, so
two _containers_ could both hold `6173` — the range exists for multiple servers inside **one** box.
`vite preview` deliberately shares the base and increments into the same range.

**2. Pin `host` == `container`, so the port you see inside is the port on the Mac.** `PortEntry`
takes an explicit `host` field — _"Exact host port to bind (omit for stable auto-allocation per
workspace/slot)"_. Omit it and COI assigns something unrelated (`6173` → `localhost:42100`), and then
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

| Project         | Band        |
| --------------- | ----------- |
| you, on the Mac | `5173–5183` |
| aperture        | `6173–6183` |
| next project    | `6273–6283` |

There is also a `ports` field for _identity-mapped_ ports — a count, published host==container,
"allocated per workspace/slot". Fewer lines, but COI chooses the numbers, which defeats the
convention. Explicit entries are worth the verbosity.

### Reading the port back

With `host` pinned, `ss` inside the container is the whole answer:

```bash
ss -ltn | grep -oE ':(5|6)[12][78][0-9]' | tr -d ':' | sort -u
```

If a mapping is ever _not_ pinned, the authoritative view is host-side — worth a shell function, since
this is the "what is Claude serving right now?" question:

```bash
for c in $(incus list -c n --format csv); do
  echo "== $c"; incus config device show "$c" 2>/dev/null | grep -E 'listen|connect'
done
```

> **`COI_PORT_<NAME>` appears only once `host` is pinned.** The schema says each entry is _"exposed to
> the session as `COI_PORT_<NAME>`"_. While `host` was auto-allocated, the live Claude process's own
> `/proc/<pid>/environ` held no `COI_*` variable at all — only the OAuth token — so the
> `COI_PORT_VITE=…` line COI writes into the generated `CLAUDE.md` preamble looked like prose rather
> than proof. With `host` pinned, all 11 are present and correct (verified 2026-08-22:
> `COI_PORT_VITE=6173` … `COI_PORT_VITE10=6183`). Read them back with
> `tr '\0' '\n' < /proc/<pid>/environ | grep COI_PORT` on the Claude pid — not from a subshell, which
> won't have inherited them. Still don't build on them: `app/vite.config.ts` derives its port from
> `hostname()`, which works identically on the Mac.

## Config files

Four files. Only the first lives in this repo; the rest are machine-local and never committed.

| File                                         | Scope                | Purpose                                                                                                                                                                                            |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.coi/config.toml`                           | **repo (committed)** | Daytime posture: `coi-default` image, `permission_mode=bypass`, CPU/mem caps, `network.mode=restricted`, the Vite `6173–6183` port map (`host` pinned == `container`), monitoring on. Secret-free. |
| `~/.coi/config.toml`                         | user (trusted)       | Auth injection: `[defaults.env_commands]` `CLAUDE_CODE_OAUTH_TOKEN = "cat $HOME/.coi-claude-token"`.                                                                                               |
| `~/.coi-claude-token`                        | user, mode 600       | The token itself. Never mounted into the workspace.                                                                                                                                                |
| `~/.coi/profiles/aperture-night/config.toml` | user (trusted)       | Night deltas: `network.mode=allowlist` + `allowed_domains`, `limits.runtime.max_duration="10h"`, `auto_stop=true`, `[monitoring.nft] enabled=false`.                                               |

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

## tmux — status bar and window restore

Container-side, in `tools/coi/`. The session keeps COI's name (`coi attach` is `tmux attach -t <session>`,
_Ending a session_) — the bar only labels itself `aperture`. Window names matter too: the board names
sessions by them, and restore matches on them.

- **Bar** (`tmux.conf`: Nord palette, the dev-lock holder from the board, the time, an amber dot on a bell).
  `~/.tmux.conf` is a symlink into `/workspace`, so a merged change is live once `/workspace` is on the new
  `main` and tmux reloads:
  ```bash
  bash /workspace/tools/coi/tmux-restore.sh links   # once, and again after a container rebuild (restore runs it too)
  tmux source ~/.tmux.conf
  ```
- **24-bit color** (`tmux.conf`: `set-environment -g COLORTERM truecolor`). tmux already passes RGB through (the
  iTerm client reports it in `#{client_termfeatures}`), but `update-environment` doesn't carry `COLORTERM`, so apps
  that read it — Claude Code — fall back to 256 colors without it. A pane opened after `tmux source` has it
  (`echo $COLORTERM`); a running pane and its processes keep their old environment — reopen the window, or
  `export COLORTERM=truecolor` and restart Claude.
- **Keys** (`tmux.conf`). The prefix is `Ctrl-a` (screen's; `Ctrl-a a` sends a real `Ctrl-a` to the shell);
  `Ctrl-b` is unbound and `d` still detaches.
  - `Ctrl-a t` — the control tower (`scripts/board/tower.sh`) in a pop-up over any window; `q` closes it.
  - `Ctrl-a g` — the hub's window, `dispatch`, by name: numbers shift as windows close (`renumber-windows`).
  - `Ctrl-a j` — fuzzy-jump to any window by name with `fzf` (`au3` finds `auto-3`; Esc cancels).
- **Window restore** (`tmux-restore.sh`): `save` snapshots each window running Claude — name, session id, cwd,
  and `--dangerously-skip-permissions` if it had it — to `localNotes/tmux-sessions.tsv` (gitignored: it holds
  session ids); with no Claude windows it keeps the last snapshot and exits 1. Restore reopens each missing
  window by name with `claude --resume <id> -n <name>`, 3 s apart, and skips windows that already exist. Run it
  inside the COI session (`coi attach`), which it fills; outside tmux it builds a separate `aperture` session
  (plus a `_boot` window) that `coi attach` won't find.
  ```bash
  bash /workspace/tools/coi/tmux-restore.sh save   # before a stop or rebuild
  bash /workspace/tools/coi/tmux-restore.sh        # after it
  ```
- **Pasting images** (`xclip`). Copy an image on the Mac (a Cmd+Ctrl+Shift+4 screenshot; Safari's Copy Image is
  expected to work, unverified: a copy that also carries text is refused, MAILROOM.md → _The clip job_),
  keep iTerm in front, and press **Ctrl+V** in a container Claude Code: it pastes as an image. `~/.local/bin/xclip`
  is a link to `tools/coi/xclip` (made by `links`), ahead of `/usr/bin/xclip` on PATH. It answers only Claude Code's
  two image calls, through the Mac mailroom's `clip` job, and never text (MAILROOM.md → _The clip job_). It needs
  the Mac mailroom installed from a `main` that has the job. With the Mac asleep, a Ctrl+V gives up after 15 s;
  a running Simulator job doesn't hold it up (the mailroom's fast lane, MAILROOM.md → _Lanes_). Cmd+Shift+4 only
  saves a file: `clip-probe` then answers `NO_IMAGE`. Don't set `DISPLAY` for Claude Code: image paste doesn't need
  it, and with it set Claude Code sends text copies to `xclip`, which refuses them. Text paste is Cmd+V as before. The shim's log is `~/.cache/xclip-shim/log`; `pnpm mailroom clip-probe` runs the
  same round trip by hand.

## GitHub access inside the container

The container has **no SSH key and no SSH agent** (COI reports "SSH agent: Not available"), and the
remote is SSH — so out of the box `git fetch` and `git push` both fail from inside, and `gh` is
unauthenticated. The practical damage isn't the missing push: it's that **every `origin/*` ref you
compare against is whatever the Mac last fetched.** That produced two confidently-wrong conclusions on
2026-09-07 — "this branch was never deployed to `dev`" and "`origin/dev` hasn't moved" — both stated as
fact from refs that were structurally incapable of being current.

**Setup — redo after any container recreate** (`~/.gitconfig` and `~/.git-credentials` are outside
`~/.claude`, so the export does not carry them — _Start here → 1_):

```bash
git config --global url."https://github.com/".insteadOf git@github.com:
gh auth login --with-token      # paste, Ctrl-D
gh auth setup-git
```

- **Run this in a separate tmux window, never through Claude.** A token pasted into a Claude prompt
  lands in the session transcript on disk.
- **The `--global` rewrite is the point.** `/workspace/.git/config` is _shared with the Mac_, so
  changing the remote there would switch your own pushes to HTTPS and break your working SSH setup.
  A global `insteadOf` is container-only and leaves both untouched.
- The token lives in `~/.git-credentials` in the container home — never under `/workspace`, which is
  the Mac's disk.

**Scope: read-only.** The PAT deliberately grants no write anywhere:

| Permission                                                | Why                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Contents: **read**                                        | `git fetch` — the whole point                                                         |
| Pull requests: **read**                                   | PR state. **Write would allow merging, and a merge to `main` IS the prod deploy**     |
| Actions: read                                             | run status, job logs, the CDK diff summary                                            |
| Variables · Secrets · Deployments · Commit statuses: read | verify config instead of asking; secret _values_ are never returned by any permission |

**Writes go through a second identity — the bot.** A fine-grained PAT authenticates _as you_, GitHub has
no per-branch token scoping, and a ruleset binds identities, not credentials — so a write PAT couldn't
distinguish "you" from "Claude acting as you" (and would inherit your admin bypass). So the PAT stays
read-only, and pushes, dev deploys and dev logs go through the GitHub App `aperture-cc-bot`
(`pnpm bot …`, since 2026-10-13), which the `main` ruleset can tell apart: it needs your code-owner
approval to merge and is never a bypass actor. Its key lives in `.secrets/ci-bot/` on the Mac disk —
setup, permissions and threat model: `docs/ops/CI-BOT.md`. (This reverses the earlier "one identity,
attributable to one human" call: commits and PRs stay yours; the bot is only the pusher.)

`Checks: read` does not exist as a fine-grained permission, so `gh pr view --json statusCheckRollup`
fails regardless. Use `gh run list` / `gh run view` — same information, Actions API.

## Gotchas (don't re-derive these)

- **Two config formats — the big one.** The main/project config (`~/.coi/config.toml`,
  `.coi/config.toml`) is the `Config` struct: `forward_env` / `env_commands` live under
  **`[defaults]`**, and it is **not** schema-validated. Profile files
  (`~/.coi/profiles/<name>/config.toml`) are **flat** top-level keys and _are_ validated by
  `coi validate profile`. **Do not run `coi validate profile` against a main/project config** — wrong
  schema (it rejects `[defaults]`), and "fixing" it by hoisting a key to top level makes that key
  silently no-op at runtime. This is what broke auth for an afternoon.
- **Auth: use `env_commands`, not `forward_env`.** `forward_env` didn't deliver reliably.
  `env_commands` runs _in the VM_ (Linux), so the Mac Keychain is unreachable — a mode-600 file is
  the equivalent. It's stripped from _untrusted project_ configs, so it **must** be user-scope.
- **Exit the TUI before you walk away — and `caffeinate` does not stop lid-close sleep.** Terminal
  garbage, clamshell sleep, VM-wide mount restart, shared `node_modules` — signatures in _Known
  failure modes_, evidence in
  [COI-INCIDENTS.md → Incident B](COI-INCIDENTS.md#incident-b--a-13-hour-unattended-run-died-and-left-the-terminal-broken).
- **A restart can drop `statusLine` from `~/.claude/settings.json`.** COI re-seeds the container's user settings at
  setup (seen 10-26 and 11-05; the 11-05 recurrence came with a full Mac copy, so whether that copy is the seed is
  disputed), and with the key gone the status line, the board
  one-liner and the usage meter log all stop without an error. `~/.claude/statusline-command.sh` itself survives.
  `pnpm usage doctor` notices; the restore is in [USAGE-METER.md → Install](USAGE-METER.md#install).
- **Night profile needs `[monitoring.nft] enabled = false`.** The nft monitor **hardcodes**
  auto-pause-on-high (ignores `auto_pause_on_high`), and "unauthorized connection attempt" fires HIGH
  on _any_ non-allowlisted egress — so benign OS background traffic (Ubuntu/Canonical, esp.
  `unattended-upgrades`) freezes the run. Disabling the monitor **keeps the allowlist DROP rules in
  force** (network isolation ≠ the monitor daemon); process + filesystem monitoring stay on. Only the
  not-allowlisted check is allowlist-only; the detector's other checks arm in **every** mode: a
  non-gateway RFC1918 destination pauses; the metadata IP and the port list (4444 5555 1234 31337 12345
  6666 6667 6697 **8080**) kill, hardcoded (`nftmonitor/netdetector.go:46,58,70`, `daemon.go:42-46`).

## Known failure modes (index)

Full forensics — timelines, log locations, ruled-out hypotheses, exact commands — live in
**[COI-INCIDENTS.md](COI-INCIDENTS.md)**. Signatures only, so you can recognise which one you have:

| Symptom                                                                                                      | Cause                                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt fills with`35;97;27M…` garbage                                                                        | A killed TUI never restored your terminal's mouse-reporting mode                                                                                                                                                                                                                                                                                        | Exit Claude cleanly (`Ctrl+D`). To recover: accept iTerm's "turn it off" prompt, or `reset`. **`stty sane` does not work.**                                                                                                                                                                                                                                                                                 |
| Long unattended run died ~when you shut the laptop                                                           | `'Clamshell Sleep'` — lid close forces sleep; **`caffeinate` does not prevent it** (and on battery it does nothing at all)                                                                                                                                                                                                                              | Lid open + AC +`caffeinate -s`; or clamshell mode / Amphetamine closed-display. Always on AC.                                                                                                                                                                                                                                                                                                               |
| `Session can't start — SIGABRT (134)` on a 2nd/3rd session                                                   | Container **pids cgroup** ceiling saturated (`limits.processes`), `clone()` → `EAGAIN`. **Not** memory, **not** a Claude bug                                                                                                                                                                                                                            | `paste -d/ /sys/fs/cgroup/pids.{current,max}` — if close, raise `max_processes` in `.coi/config.toml` (now `4096`, 2026-10-13; `2048` was verified landing). Hot-patch: `incus config set <ctr> limits.processes 8192` on the **host**. **Always verify a fresh container reports the number you wrote** — `1024` silently didn't take, `2048` did, and the difference was never explained.                 |
| Every container loses its mounts at once, then the VM reboots                                                | A host-mount config change: the path must be visible in the Lima VM first, so applying it restarts the VM and kills every session                                                                                                                                                                                                                       | Make mount changes **before** starting a long run                                                                                                                                                                                                                                                                                                                                                           |
| `vite dev`/`build`: `Cannot find module '../lightningcss.*.node'` (or a `@tailwindcss/oxide` binding error)  | `node_modules` is shared with the macOS host; native binaries belong to whoever installed last                                                                                                                                                                                                                                                          | `pnpm install` on the side you're using (`CI=true` inside the container). Doesn't affect `tsc`/`vitest`.                                                                                                                                                                                                                                                                                                    |
| Container `Frozen`, "PAUSED due to security threat" — on session start, or the moment you run `pnpm install` | Two detectors, one pair of keys: startup read I/O, or `pnpm install` writes (the write detector borrows `file_read_*`, `detector.go:36-37` on v0.15, so 50 MB / 10 MB/s applies to a 127 MB, 61 MB/s install). Whole-container cgroup I/O, not just the workspace. Both false positives; or a Bash line containing `/curl`/`/wget` (Sigma — Incident H) | `coi unfreeze <name>`. Triage: _Start here → 2 → Container frozen — find out what tripped it_ (raw file, never `coi audit <name>`). Reasoning: [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md)                                                                                                                                                                                                            |
| `coi audit <name>` prints nothing for a container you can see in `coi list`                                  | CLI read-path defect — the on-disk history exists and is complete                                                                                                                                                                                                                                                                                       | Read `~/.coi/audit/<name>.jsonl` directly — see _Start here → 2 → Container frozen_. `coi audit -f` is for live monitoring only.                                                                                                                                                                                                                                                                            |
| Session lost after a crash / reboot / lid-close, with no `coi shell` teardown                                | The export only fires on the `coi shell` teardown — an ungraceful death exports nothing, so everything since the last exit is gone with the container                                                                                                                                                                                                   | No fix, by design — no continuous backup. Exit `coi shell` at every real break and reattach with `coi attach`; not `coi shutdown`, which exports nothing and forks the session. If it ever bites for real, `CLAUDE_CONFIG_DIR` (_Deferred_) — **not** a `projects` symlink, which breaks the restore. After a monitor **kill**, the `forensics_on_kill` copy holds it — _Start here → 2 → Container killed_ |
| Previous session gone; `--resume` doesn't offer it                                                           | Bare `coi shell` on a torn-down container; or a `~/.claude/projects` symlink (removed 2026-09-07 — _One-time setup_ step 12), which COI skips at export; or `~/.coi/` lost to a VM rebuild, since it is VM-local                                                                                                                                        | `ls -ld ~/.claude/projects` — an arrow into `/workspace` is the symlink; remove it per step 12. Otherwise `coi shell --resume`. Recover by hand from `localNotes/coi-state/sessions-claude/<id>/.claude/projects/` or `.../container/projects/`. Prevent the rebuild case with step 10 (`scripts/coi-vm-setup.sh`).                                                                                         |
| `coi` profiles or `~/.coi` config vanished                                                                   | Same cause: `~/.coi/` lives on the VM disk, not the Mac                                                                                                                                                                                                                                                                                                 | _One-time setup_ step 10 (`scripts/coi-vm-setup.sh`). Recreate the profile once, then it persists.                                                                                                                                                                                                                                                                                                          |
| Four "ephemeral" containers alive, GBs each                                                                  | Ephemeral destroy +`--resume` write happen only on the `coi shell` teardown                                                                                                                                                                                                                                                                             | Tear down properly when done — see*Run → Ending a session*                                                                                                                                                                                                                                                                                                                                                  |
| VM at 90 %+ memory, load > 100, every session unusable; one grep at many GB                                  | A padded-regex (`.{0,N}`) search over files ([COI-INCIDENTS.md](COI-INCIDENTS.md) → Incident I)                                                                                                                                                                                                                                                         | Kill that PID from the Mac. The Bash guard now refuses the shape: scoped `rg` under `timeout`, `-C` for context                                                                                                                                                                                                                                                                                             |
| Zero-byte, write-only files under `/workspace` that the container can't read or `rm`, even with `sudo`       | Node's `fs.cpSync` writing onto the virtiofs mount ([COI-INCIDENTS.md](COI-INCIDENTS.md) → Incident J)                                                                                                                                                                                                                                                  | Remove them on the Mac. Copy with `copyFileSync` (as `scripts/src/lane/archive.ts` does)                                                                                                                                                                                                                                                                                                                    |

## Ops notes

- **Resume.** An ephemeral container left Running (Claude exited, `coi shell` never torn down) still
  holds the transcript at `/home/code/.claude/projects/-workspace/<id>.jsonl` — nothing has been
  exported yet, since the export fires on `coi shell` exit. That is `claude --resume` (the Claude
  Code flag), not `coi shell --resume` (which is about the container). `incus file pull` the
  transcript out, or relaunch in place:
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
  `pnpm test`, a dev server, and headless Chromium simultaneously on an 18 GiB / 9 CPU box — and
  don't chase it as a code defect. The session board's history (`localNotes/board/history/`,
  `docs/ops/SESSION-BOARD.md`) records memory PSI, anon and pids every 30 s and per heavy job, so a
  recurrence can be lined up against the load at that moment.
- **Cleanup.** `coi kill <name>` / `coi clean` for stale ephemeral boxes.

## Deferred / to-do

- **`[limits.cpu] allowance = "80%"` isn't landing.** A container booted 2026-08-22 reports
  `cpu.max = max 100000` — no quota — while `memory.high` and `pids.max` both match the file. Same
  class as the `max_processes` miss that broke second sessions (fixed as of `54fbe95`, cause never
  confirmed), and now the last
  known instance of it. Nothing has been observed starving, so this is config correctness, not a live
  failure. Diagnosis commands:
  [COI-INCIDENTS.md → Incident A → _Verify it took_](COI-INCIDENTS.md#verify-it-took).
- **`coi audit`'s read path.** `~/.coi/audit/<container>.jsonl` holds complete per-poll telemetry;
  `coi audit <name>` returned empty for a fully populated file (corrected 2026-09-06) — just
  `cat`/`grep` the file. Worth filing
  upstream as a CLI defect, not a missing feature. See [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md).

- **Session-restore leftovers (2026-09-07).** `coi shell --resume` restores `~/.claude` completely
  (_Run → Ending a session_). Three loose ends, none blocking:

  - **Memory restore is untested.** `~/.claude/projects/-workspace/memory/` comes back as a
    directory, but it has been empty for this project's whole life — no files, no `MEMORY.md`. So
    what's proven is that the directory is carried, not its contents. Next time memory actually
    holds something, check it survives a `coi shutdown` cycle.
  - **`~/.claude.json` is not carried.** It returns reset — `numStartups: 1`, `history: []`. Turned
    out not to matter: `↑` prompt history lives in `~/.claude/history.jsonl`, which restores intact
    (44 entries verified across a cycle). Recorded so nobody re-investigates the empty `history`
    array and concludes something is broken.
  - **The step-10 mirror is a sync, not an archive.** `localNotes/coi-state/sessions-claude/` tracks
    deletions on the VM side — the `3fc721de-…/.claude/` subtree vanished at 10:45 and reappeared at
    11:43 on 2026-09-07. Fine as a mirror; don't treat it as a place old sessions accumulate.

- **`CLAUDE_CONFIG_DIR` via `env_commands` — the only remaining answer to an ungraceful death.**
  Nothing is exported between `coi shell` exits, so a VM rebuild or storage loss without one
  still costs you the window. The fix is _not_ a `projects` symlink (that breaks the restore — see
  _One-time setup_ step 12); it's relocating all of `~/.claude` onto Mac disk:

  ```toml
  # ~/.coi/config.toml — user scope, trusted
  [defaults.env_commands]
  CLAUDE_CONFIG_DIR = "echo /workspace/localNotes/coi-state/container/claude"
  ```

  Verified real (39 hits for the variable in the installed binary). Unverified: whether
  `~/.claude.json` follows it (lives outside `~/.claude`), and whether it composes with COI's
  `CLAUDE_CODE_OAUTH_TOKEN` injection. Costs `.credentials.json` on Mac disk — a revocable OAuth
  token in a gitignored directory. **Don't do this pre-emptively**; the native restore works.

Not blockers — the rig is fully operational without these. Polish, in rough priority order.

- **Build a `coi-aperture` image — lean box + chromium in one job.** These were two separate parked
  items; they're one image build, and the pids incident makes it worth doing. `coi-default` is the
  "Docker" image, so `dockerd` + `containerd` + `unattended-upgrades` + a pile of Ubuntu daemons run
  idle. Measured 2026-08-22: **66 idle tasks → 30** after trimming, with the toolchain unaffected —
  over half the box's pids budget was noise (full table: [COI-INCIDENTS.md](COI-INCIDENTS.md) →
  _Incident A → What's actually burning pids_). Because the container is **ephemeral**, doing it in a
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
    # mise's global pins shadow the repo's own pnpm/typescript/tsx versions (see Start here → 1).
    # Leave mise owning only what the repo doesn't declare.
    "sed -i '/npm:pnpm/d; /npm:typescript/d; /npm:tsx/d' /home/code/.config/mise/config.toml || true",
    "mise uninstall npm:pnpm npm:typescript npm:tsx || true",
    "corepack enable",
  ]
  ```

  `coi build --profile <name>` publishes it; then point `[container] image` at `coi-aperture`.
  **`mask` snapd, don't `disable`** — `snapd.socket` is socket-activated, so one stray `snap` call
  wakes ~45 threads. Two knock-ons: chromium unlocks in-container Playwright / the `run-app` visual
  skill (the only thing missing from `coi-default` for the full loop), and dropping
  `unattended-upgrades` removes the night-pause trigger we currently paper over with
  `[monitoring.nft] enabled=false`, so the night profile could re-enable the monitor — verify no
  other benign egress trips it first.

- **Verify nft network _alerting_ on Mac.** Containment (allowlist DROP rules) is proven; whether the
  monitor _daemon_ raises anomaly events on Mac is unconfirmed — we sidestepped it by disabling the
  monitor at night. To verify: in a daytime `restricted` shell, stream `coi audit -f` and trip a
  benign detector (e.g. a `grep -r secret /home/code` credential-scan pattern, or an egress to a
  non-allowlisted host); a WARNING/HIGH event means alerting works. If nothing fires, it's the
  "network monitoring degraded on macOS" case — accept containment-only, or set
  `[monitoring.nft] lima_host = "incus"` and retry.
- [x] **Strip the dead `[defaults] forward_env` line from `.coi/config.toml`** — done. Auth moved to
      `env_commands` in the user config; only the header comment on line 3 still mentions `forward_env`.
- **Explore `coi snapshot` (checkpoint / rollback).** Never exercised. Would let an unattended run
  checkpoint container state before a risky step and roll back on failure. Check the Snapshot
  Management wiki page for syntax; decide whether it's worth wiring into the night flow.

## Security posture

- **No AWS creds in either profile.** Default-deny means "do nothing" is already correct — never add
  them. Deploys are CI/OIDC; local `cdk deploy` is off-path.
- **No push to `main`/`dev`, ever.** Enforced by the harness (`.claude/hooks/gh-safety-guard.sh`)
  riding in via the workspace mount — fires in-container as long as `jq` is present (it is, in
  `coi-default`) — and, for the bot, by the `main` ruleset (`docs/ops/CI-BOT.md`). Bot pushes and dispatches work
  daytime (restricted net reaches GitHub); the night allowlist omits GitHub, so an unattended run
  **structurally cannot push**. Since v0.14 COI also
  blocks commits and pushes to `main`/`master` itself, via root-owned in-container git hooks
  (`[git] protected_branches`, settable only in `~/.coi/config.toml` — the repo value is ignored).
- **Secrets that cross in:** the OAuth token, revocable via `claude setup-token` / account settings, and
  the bot's App key on the workspace mount (`.secrets/ci-bot/`, read in-process by `pnpm bot`; hooks deny
  Claude's own tool calls on it, but any process in the container — an install script, code Claude runs — can
  read it; rotate in the App's settings — CI-BOT.md → _Threat model_). Nothing else is forwarded.
