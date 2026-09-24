# COI incidents & forensics

Post-mortems for failures that cost hours, kept out of
**[COI-SANDBOX.md](COI-SANDBOX.md)** so the runbook stays a runbook. That file carries a
one-line signature index; this file carries the evidence.

House rule for this file: **log-backed where a log line is quoted, inferences labelled as such.**
Dead ends are recorded on purpose so nobody re-explores them. Applies to any COI project.

| # | Incident | Date | One-line cause |
| --- | --- | --- | --- |
| A | `SIGABRT (134)` starting a 2nd session | 2026-08-21 | pids cgroup ceiling (`limits.processes = 300`) saturated; `clone()` → `EAGAIN` |
| B | 13-hour unattended run died; terminal left spewing mouse codes | 2026-08-22 | Laptop lid closed → `'Clamshell Sleep'`; killed TUI never restored the terminal |
| B.1 | Every container lost its mounts, VM rebooted | 2026-08-21 | A host-mount config change requires a Lima VM restart |
| C | `vite` can't find a native binding | ongoing | `node_modules` shared with the macOS host across two platforms |
| D | VM rebuilt from scratch; sessions and `coi` profiles gone | 2026-09-06 | A stray `-` in `limactl edit`'s `mounts:` block; `~/.coi/` was VM-local, so the rebuild deleted it |
| E | Container froze on a HIGH threat verdict 2 min into a session | 2026-09-06 | False positive: session-start read I/O tripped `file_read_rate_mb_per_sec`; `coi audit` then failed to surface the event it had on disk |
| F | Container **killed** three times mid-session, CRITICAL "reverse shell" | 2026-09-07 | False positive: a hardcoded pattern list flags `python3 -c`, gated only on "the command contains a `:`". Routine JSON one-liners match |
| G | 2026-09-07 config-iteration afternoon: session forks on every `--resume`; container-local dotfiles (git identity, mise shadowing) | 2026-09-07 | `--fork-session` on every resume (not COI's doing); `~/.gitconfig` + mise pins live on the rootfs and evaporate per container |

---

# Incident A — `SIGABRT (134)` when starting a second session

**TL;DR:** Not memory, not a Claude Code bug. The container's pids cgroup ceiling
(`limits.processes`, templated to `300` by coi) was saturated at ~295. A second session needs ~15
more threads, `clone()` returns `EAGAIN`, and the runtime `abort()`s. Fix: raise `max_processes` in
`.coi/config.toml` — now `2048`, and **verified landing** as of `54fbe95`. Raising the number is not
by itself the fix: the first bump (`1024`) never reached Incus and the reason was never confirmed, so
always measure. See *Verify it took*.

### Symptom

```
Session can't start — SIGABRT (134) before init
```

- Fails on the **second** session, never the first.
- Fails **before init**, so nothing about the new session's own config is implicated.
- **Intermittent**: fails now, would have worked ten minutes ago — because `headless_shell`
  (Puppeteer/Playwright from a `/run` or a test) appears mid-session and is the spikiest consumer.

### 134 vs 137 — the distinction that shaped the whole investigation

| Exit | Signal | Meaning |
| --- | --- | --- |
| **137** | SIGKILL | cgroup OOM killer — killed **from outside** |
| **134** | SIGABRT | the runtime detected failure and gave up — a **refused or self-imposed** limit |

134 means a ceiling it couldn't recover from: heap limit, `ulimit -d`, or a refused
`fork()`/`clone()`. **Not** general memory pressure. Sessions spawned from agent view share the
parent runtime rather than getting a fresh process, so the second one allocates on top of the first.

### Confirmed cause — pids exhaustion

```bash
# inside container — the money shot
cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids.current
300
282
```
```bash
# on the HOST
incus config show <ctr> --expanded | grep -i 'limits\.'
  limits.processes: "300"
journalctl -k | grep -iE 'oom|cgroup'
  kernel: cgroup: fork rejected by pids controller in /lxc.payload.<ctr>/system.slice/snapd.service
  kernel: cgroup: fork rejected by pids controller in /lxc.payload.<ctr>/.lxc
  kernel: cgroup: fork rejected by pids controller in /lxc.payload.<ctr>/init.scope
```
**No OOM-kill entries at all** — confirming the 134-not-137 reasoning. And `init.scope` being
refused means the container was *saturated*, not marginally over.

Userspace named the errno outright:
```
thread 'main' panicked at tokio-1.53.1/.../worker.rs:514:
OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
```
**`os error 11` = `EAGAIN`** — exactly what the pids controller returns when it refuses a `clone()`.
A Rust component panics on it; the Bun side hits the same wall and `abort()`s → 134.

### Ruled out (don't re-explore)

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| V8/JSC heap OOM | **No** | 5.80 GiB of 12 GiB used, and `limits.memory.enforce: soft` means no hard cap was being enforced anyway |
| `NODE_OPTIONS=--max-old-space-size` | **Not applicable** | `HeapHelper` + `Bun Pool N` threads ⇒ this is the **Bun/JSC native binary**, where `NODE_OPTIONS` is silently ignored. Check `which claude` / `claude doctor` before reaching for it — it costs an hour. |
| LXCFS `/proc/meminfo` mismatch | **No** | `/proc/meminfo` says 16 GiB, `cgroup/memory.max` reads `max` (soft enforce uses `memory.high`). Nothing hard-capped. |
| rlimits (`limits.kernel.*`) | **No** | `incus config show --expanded \| grep 'limits.kernel'` → empty |

### Why pids counts higher than you expect

The pids controller counts **tasks (threads)**, not processes — `ps -e` undercounts, use `ps -eL`.
Multipliers stack: Bun/JSC adds a `Bun Pool` threadpool + 5 `HeapHelper` GC threads *per process*;
one thread per MCP server connection; **MCP servers are not deduplicated across sessions** (N×M, and
not reliably cleaned up); Chrome brings its whole thread zoo.

Measured: foreground Claude session ≈ **15 threads**; lighter helper processes ≈ 8. Claude is *not*
the fat one — at the time of failure `headless_shell` held ~60, the Next dev server ~60, snapd +
snapfuse ~45, docker/containerd/buildkitd ~24.

> **Attribution trap.** Running `ps -eLo comm` on the *host* mixes in host processes (`incusd`,
> `lima-guestagent`, `snapfuse`, ZFS `z_fr_iss_1`) and misleads. Run it **inside** the container, or
> read `cat /sys/fs/cgroup/lxc.payload.<ctr>/pids.current` (which **is** recursive).
> `cgroup.threads` reads empty — cgroup v2 forbids tasks in an internal node; they live in leaves.

### Fix

```bash
# 1. PERSISTENT — .coi/config.toml. Without this, every new coi-* instance drifts back to 300.
[limits.runtime]
max_processes = 2048   # was 300

# 2. HOT-PATCH a running container — takes effect immediately, no restart. On the HOST.
incus config set <ctr> limits.processes 8192

# 3. VERIFY (inside container)
paste -d/ /sys/fs/cgroup/pids.{current,max}
295/8192        # before the fix this read 295/300 — five threads of headroom
```

> **Two traps.** `incus config set` runs on the **host**; from inside the container shell it
> silently does nothing. And don't verify with
> `awk '{print $1"/"$2}' /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max` — each file holds one
> field on one line, so `$2` is always empty and you get `295/` then `300/`. Use `paste -d/`.

### Verify it took

Committing the config change is not the same as fixing it. **Resolved as of `54fbe95`, cause
unconfirmed** — the first attempt silently did nothing, which is the reason this section exists.

Measured on `coi-88cded0c-1`, booted 09:00 PDT — an hour *after* `edf1d4e` set
`max_processes = 1024`:

```
/sys/fs/cgroup/pids.max      → 300      # the bump did NOT land
/sys/fs/cgroup/memory.high   → 12GiB    # ...but the memory cap did
/sys/fs/cgroup/cpu.max       → max      # and the 80% CPU allowance didn't either
```

Re-measured later the same day on a container booted from `54fbe95` (`max_processes = 2048`):

```
/sys/fs/cgroup/pids.max      → 2048           # lands now
/sys/fs/cgroup/memory.high   → 12GiB          # still lands
/sys/fs/cgroup/cpu.max       → max 100000     # 80% allowance STILL doesn't land
```

(`cpu.max` is `"$QUOTA $PERIOD"`, so `max 100000` and the bare `max` recorded above are the same
state — no quota. Same reading, transcribed at different widths.)

**What's verified:** `pids.max` now matches the file, with 69 tasks against 2048 — the SIGABRT
trigger is gone. **What is _not_ verified:** *why*. Nothing in the diff between the two runs targets
the merge path — `1024 → 2048` is the same key in the same section — so the likely cause is
something done on the host between them (a `coi trust` re-run being the prime suspect), not the
value itself. Don't read this as "the key works"; read it as "verify every time."

The CPU allowance is still not reaching Incus, so the diagnosis path below stays live for that key —
swap `max_processes` for `allowance` in the greps. Candidates, in order of suspicion — **all of
these run on the host:**

```bash
# 1. Trust voided by the edit. .coi/config.toml's own header says "project config -> run coi trust";
#    editing it after trusting may drop the repo config (or parts of it) from the merge.
coi trust

# 2. A user-level value winning the merge chain (user -> repo -> profile, scalars last-wins).
grep -rn max_processes ~/.coi/ ~/.config/coi/ 2>/dev/null

# 3. Wrong key or section for this COI version.
coi schema profile | grep -i process

# 4. An Incus profile overriding the instance value.
incus config get <ctr> limits.processes             # instance level
incus config show <ctr> --expanded | grep processes # effective
incus profile show <profile> | grep processes       # set it here if instance-level is ignored
```

Don't call it fixed until a **fresh** container reports the number you wrote.

### What's actually burning pids — measured 2026-08-22

Raising the ceiling is the fix; this is defence in depth. Measured on a fresh `coi-default` box with
one Claude session and nothing else: **66 tasks idle → 30 after disabling the list below.** 55%
reclaimed, and `node` / `pnpm` / `git` / `tsc` all verified working afterwards.

| Service | Threads | Needed here? | Verdict |
| --- | --- | --- | --- |
| `dockerd` + `containerd` | **23** | 0 containers, 0 images | Biggest single win. Off. |
| `udisks2` | 6 | Disk/removable-media manager | Meaningless in a container. Off. |
| `polkit` | 4 | Auth agent for udisks/NM | Off *with* udisks; sudo is passwordless. |
| `rsyslog` | 3 | Duplicates journald | Off. |
| `unattended-upgrades` | 2 + apt forks | No | Off — and it's the nft night-pause trigger. |
| `snapd` + `snapfuse` | 0 idle, **~45 awake** | Nothing consumes snaps | `snapd.socket` is socket-activated, so **`mask`, don't `disable`** — one stray `snap` call wakes it. |
| `cron` | 1 + spikes | No | Forks logrotate / man-db / apt. Off. |
| `ModemManager`, `multipathd`, `open-iscsi`, `lvm2-monitor`, `apport`, `pollinate`, `sysstat`, `open-vm-tools`, `vgauth`, `ubuntu-advantage`, `ufw`, `cloud-init*` | boot forks | No | Enabled-but-idle. Free to strip. |

Trimmed baseline is 8 services: journald, logind, networkd, resolved, udevd, dbus, polkit,
console-getty.

**Because the container is ephemeral, `systemctl disable` evaporates on destroy** — this has to be
baked into a custom image to be worth anything. See COI-SANDBOX.md → *Deferred / to-do* → the
`coi-aperture` image.

### The multipliers — these are what actually spike you

The idle baseline never caused the abort. These arrive mid-session, which is exactly why the failure
looks intermittent:

- **`headless_shell` ≈ 60 threads** — the spikiest single thing in the box. `--renderer-process-limit=1`
  trims it; killing the browser before tests (the CLAUDE.md rule) is the real control.
- **Vite dev server ≈ 35–60** — node plus 4 libuv workers *per process*. `UV_THREADPOOL_SIZE=2`
  roughly halves the worker share.
- **`pnpm test -r`** — one Vitest per package, each with its own worker pool. Nothing in the repo caps
  it today; `poolOptions.threads.maxThreads` would bound it.
- **MCP servers × sessions** — no dedup across sessions, so it's N×M, and they aren't reliably reaped
  when a session ends. The failed container had 6 live `claude` processes.
- **Claude Code itself: ~16 threads/session** (measured 16, matching the ~15 estimate). Not the fat one.

### Triage: "session can't start"

`limits.processes` fails **silently** — the error says nothing about pids. So check this *first*:
```bash
paste -d/ /sys/fs/cgroup/pids.{current,max}
```
Close numbers ⇒ pids exhaustion, whatever the error claims. Then in order:

1. `journalctl -k | grep -i cgroup` **on the host** → `fork rejected by pids controller`
2. Distinguish **134** (self-abort → refused limit) from **137** (OOM killer → memory)
3. `ps -eLo comm --no-headers | sort | uniq -c | sort -rn | head -20` **inside** the container
4. Reproduce in the foreground with `claude --debug` — background/agent sessions swallow stderr, so
   the abort text never reaches your terminal
5. *Only then* memory: `cat /sys/fs/cgroup/memory.max`, `ulimit -d -v -u`

### Budgeting

At ~16 threads per foreground session plus a browser and a dev server, **300 only ever budgeted for
one session.** A pids ceiling is a *ceiling, not a reservation* — raising it costs nothing, memory is
the real constraint, so be generous. Honest steady-state budget: chromium 60 + vite 60 + 4 sessions ×
16 + docker 23 ≈ **210**, with `pnpm -r` fanning out on top. `1024` is the floor; **`2048` is what's
set** (`54fbe95`) and measured landing, at ~10× the honest budget. Go higher only if a real ceiling
is ever hit again — the number costs nothing, but a change that doesn't land is worse than no change.

### Open follow-ups

- [x] `max_processes` 300 → 1024 written into `.coi/config.toml` (`edf1d4e`)
- [x] **Make that value actually take effect** — `1024` didn't land; `2048` (`54fbe95`) does. A
      container booted 2026-08-22 reports `pids.max = 2048`. Cause of the first miss never
      confirmed; see *Verify it took* above.
- [ ] **`[limits.cpu] allowance = "80%"` still isn't landing** — same box reports
      `cpu.max = max 100000` (no quota). Nothing has been observed starving, so this is a
      correctness-of-config item, not a live failure.
- [ ] Bake the service trim + chromium into a `coi-aperture` image — one job, closes two parked items
      (COI-SANDBOX.md → *Deferred / to-do*)
- [x] Add the pids check to the session-start ritual, since the failure mode is silent — done
      (COI-SANDBOX.md → *Run* → "First command in a new container", and *One-time setup* step 11)
- [ ] Trim MCP servers per-session — they multiply N×M with no dedup

---

# Incident B — a 13-hour unattended run died, and left the terminal broken

Written up after a 2026-08-21/22 debugging session that cost several hours.

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
2. Manually — `\033` not `\e`, since BSD `/usr/bin/printf` doesn't understand `\e`, and this is a
   line you paste into an already-broken terminal:
   ```
   printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1015l\033[?1004l\033[?2004l'
   ```
   The last two also clear **focus reporting** (`1004`) and **bracketed paste** (`2004`), which
   Claude Code enables too and which leave their own garbage (`^[[I`, `^[[200~`).
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

**COI's own audit — read the file, not the CLI:**
```bash
tail -50 ~/.coi/audit/<container-name>.jsonl        # per-poll telemetry, whole container lifetime
grep '"level":"high"' ~/.coi/audit/<container-name>.jsonl
coi audit -f <container-name>                        # live follow only
```
> Corrected 2026-09-06: the file holds complete per-poll history; only the `coi audit <name>` read
> path is broken — see *Incident E* (dead end + root cause 2).

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
# ⚠️ `journalctl -k` covers THE CURRENT BOOT ONLY. If the VM rebooted since the incident (it
# usually has — `limactl shell` auto-starts a stopped instance) this tells you nothing at all.
sudo ls /var/log/journal 2>/dev/null || echo "journal is VOLATILE — prior boots are GONE"
sudo journalctl --list-boots
sudo journalctl -k -b -1 | grep -iE "oom|killed process"        # OOM kill
sudo journalctl -k -b -1 | grep -iE "suspend|resume|clocksource" # big clock jump = VM was suspended
sudo incus info <container> --show-log
sudo sh -c 'ls -la /var/log/incus/'
sudo sh -c 'grep -iE "stop|shutdown|missing source" /var/log/incus/incusd.log*'
sudo sh -c 'zcat -f /var/log/incus/incusd.log* | grep -iE "<date> (08|09):"'
sudo sh -c 'cat /var/log/incus/<container>/*.log'
```

> **The `sudo` + glob trap.** `sudo grep … /var/log/incus/incusd.log*` fails, because **your shell
> expands the glob as you**, before `sudo` runs, and `/var/log/incus/` is `drwx------ root`. What you
> see depends on the shell: **zsh** gives a hard `zsh: no matches found:` and `sudo` never runs;
> **bash** (or zsh with `unsetopt nomatch`) passes the literal `*` through and you get grep's
> *"No such file or directory"*. Either way: wrap it — `sudo sh -c '… /path/*'`.

> **Absence of log entries ≠ nothing happened.** `incusd` only writes warnings/errors, so a quiet
> multi-hour session leaves no trace at all. `incusd.log` rotates at midnight; if the incident sits
> between a rotation and the next daemon start, there may be **no** incus-side record whatsoever.

### B.1 — 2026-08-21 20:10:49 — the VM restart (self-inflicted config change)

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

**Cause: applying a writable host mount for a project.** The mount block involved was:
```yaml
mounts:
  - location: "~/Coding/Personal/WebDev/psi-omega-website"
    writable: true
```

> **Which file held it is genuinely unresolved, and it matters.** That syntax is YAML and is
> character-for-character the **Lima** form from *One-time setup → step 1* (`limactl edit incus`).
> Aperture's `.coi/config.toml` is TOML (`[[ports.map]]`, `location = "…"`) and could not hold it.
> The operator recalls editing a project `.coi/config.toml`. Both can't be literally true. **Check
> `limactl edit incus` and the project's `.coi/config.toml` side by side before trusting either
> framing.**

What *is* established from the logs, regardless of which file was edited: **a new Lima boot ID
appears at 20:12:03**, and every container's host mounts vanished at 20:10:49. Mechanically that has
to happen — for Incus to bind-mount a host path into a container, the path must first be visible
**inside the Lima VM**, which needs a Lima `mounts:` entry, which needs a VM restart. So the
operational lesson holds either way:

> **A project-level mount change is a VM-level event. It kills every running Claude session in
> every container, across every project.** Do mount/config changes *before* starting a long run.

Diagnostic signature: mounts vanishing for **all** containers at the same instant, followed by an
**orderly** `Stopping incus.service`. Orderly shutdown ⇒ someone asked for it.

### B.2 — 2026-08-22 09:11:40 — the lid (the actual kill)

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
- **No** `Stopping incus.service` between 20:12 (Aug 21) and 16:55 (Aug 22) — meaning incus was
  never *asked* to stop, which is consistent with a suspend rather than a shutdown. (Don't read the
  absence as proof of abruptness; see the "absence ≠ nothing happened" warning above. The abruptness
  is established by the *terminal state*, not by a missing log line.) Contrast **B.1**, which
  logged an orderly stop.
- 09:11:40 → 16:53:56 is ordinary `Maintenance Sleep` / `DarkWake from Deep Idle` cycling with RAM
  powered — **not** hibernation. The VM was paused, not destroyed.
- The VM cold-booting at **16:55:15** is not a second failure: `limactl shell` **auto-starts a
  stopped instance**, and that's what running it to investigate did.

### Ruled out — with the evidence, so nobody re-checks these

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| OOM kill | **Unproven — NOT "no"** | The grep came back empty, but it ran against the **post-incident boot** (VM cold-booted 16:55:15), so it could not have contained the incident. Re-run as `journalctl -k -b -1`, and only if `/var/log/journal` exists. |
| `max_duration` / `auto_stop` | **No** | Not set on the daytime profile; container still `RUNNING` after |
| nft monitor auto-pause/kill | **Unprovable** | `auto_kill_on_critical=true` *was* live (daytime profile). Not checked at the time, under the belief that `coi audit` keeps no history (superseded 2026-09-06: the file exists, the CLI read path failed — Incident E). Container was `RUNNING` and auto-pause pauses rather than kills, so unlikely. |
| VM suspend/resume tearing the VM down | **No** (but on other evidence) | Same defect as above: "only fresh-boot lines" is the *expected* `journalctl -k` output on a fresh boot regardless. The real evidence is positive: the Mac was in ordinary DarkWake cycling with RAM powered 09:11→16:53, so the VM was paused, not destroyed. |
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
genuine hibernation (unlike **B.2**) and **no assertion of any kind stops it** — not caffeinate,
not Amphetamine. **Unattended runs must be on AC.** Full stop.

### Container leak — the cost of skipping `coi shutdown`

Four "ephemeral" containers were alive simultaneously (`coi-d2220571-1/-2/-3`, `coi-88cded0c-1`);
`-3` alone held **2.93 GiB** and 205 processes. Not because anything crashed — because ephemeral
destroy (and the `--resume` session write) happen **only** on the `coi shell` teardown, and none of
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

---

# Incident D — a YAML typo rebuilt the VM and deleted two Claude Code sessions

**2026-09-06.** Raw contemporaneous write-up: `localNotes/aperture-coi-incident-report.md` and
`localNotes/coi-session-persistence-test.md` (both gitignored — this section is the durable copy,
and is self-contained). The rejected Lima buffer is preserved at `localNotes/lima.REJECTED.yaml`.

Two things happened in one evening. The rebuild is here; the false-positive threat pause that
followed it is **Incident E** below.

## Timeline

| Time | Event |
| --- | --- |
| earlier | `ls /workspace` in a `coi shell` shows the **entire Mac home** — `.ssh`, `.aws`, `.gitconfig`, Desktop, Documents. The Lima `mounts:` block is `- location: "~"`. This is a real security finding, independent of everything below, and is the reason a `mounts:` edit was attempted at all. |
| 19:15 | A separate thread opens: a previous Claude Code session was lost ("i lost my cc session permanently"), so `coi shutdown`'s persistence claim gets a written test plan. Its preferred fix is *also* a mount change (scoped host mount of `~/.claude/projects`). Both threads now point at `limactl edit incus`. |
| 19:18–19:20 | The VM-side before/after snapshot for that test is captured — and not read back until much later. It turns out to hold the answer (see *The session-export finding*). |
| 19:46 | `.coi/config.toml` → `persistent = true`, as a stopgap against further session loss. |
| 19:55 | `limactl edit incus`. The YAML is rejected. Recovery attempts end with the `incus` instance recreated from scratch. |
| 20:08–20:30 | Full manual bootstrap of the VM from nothing (below). |
| 20:31 | First `coi shell` on the rebuilt VM — and the first container ever to run `persistent = true`. |
| 20:33 | Container freezes on a HIGH threat verdict → **Incident E**. |

## Cause — one character

`limactl edit incus`, narrowing `mounts:` from `~` to the project path. The buffer written was:

```yaml
mounts:
- location: "/Users/<you>/Coding/Personal/aperture"
- writable: true      # <-- this dash makes it a SECOND list item
```

Lima rejected it:

```
FATA[0372] the YAML is invalid, saved the buffer as `lima.REJECTED.yaml`:
field `mounts[1].location` must be an absolute path, got `.`
```

The dash turns `writable: true` into `mounts[1]` — a map with no `location`, which Lima defaults to
`.`. Correct form indents it under the first item:

```yaml
mounts:
- location: "/Users/<you>/Coding/Personal/aperture"
  writable: true
```

**COI-SANDBOX's *One-time setup* step 1 already showed it correctly.** The runbook was right; the
edit deviated from it. That is the argument for `scripts/coi-vm-setup.sh` existing at all —
knowledge that lives only as prose does not survive contact with a live `limactl edit`.

Recovering from the rejected buffer ended with the instance recreated — **not** via a deliberate
`limactl delete`. (*Inference*: the precise step that triggered recreation was not captured. The
outcome is certain; the trigger is not. Do not re-derive it — capture it live if it ever recurs.)

First sign, on reconnecting:

```
$ coi shell
Command 'coi' not found, did you mean: command 'co' from deb rcs (5.10.1-3)
$ systemctl status incus
Unit incus.service could not be found.
$ grep root /etc/subuid /etc/subgid
(empty — confirms a fresh, never-provisioned VM)
```

## Why it cost data — `~/.coi/` is VM-local

This is the part worth internalising, and the part the original write-up got wrong.

`~` inside the Lima VM is `/home/<user>.guest` — the VM's own disk. The Mac is reachable only at
`/Users/<you>/…`, and only through whatever `mounts:` exposes. So:

| Path | Lives on | Survives a VM rebuild |
| --- | --- | --- |
| `/workspace` (the repo) | Mac disk, via virtiofs | **yes** |
| `<repo>/.coi/config.toml` | Mac disk — it's in the repo | **yes** |
| `~/.coi/` — profiles, aliases, trust, **exported sessions** | VM disk | **no** |
| the container's own `~/.claude` | container rootfs, on the VM disk | **no** |

Destroyed by the rebuild:

- **Session transcripts `94ef8ba6` and `12279d4a`** — both correctly exported at `coi shell`
  teardown, both unrecoverable.
- **The `aperture-night` profile** (`~/.coi/profiles/aperture-night/config.toml`) — the unattended
  overnight rig config. Its absence is silent until the next overnight run needs it.
- `~/.coi/config.toml`, aliases, trust state.
- The VM's `~/.gitconfig` — git identity had to be re-set before the next commit would go through.
- Incus daemon install, storage pool, network bridge, the built `coi-default` image, subuid/subgid
  delegation, and the `coi` binary.

Not destroyed: the repo and all work product. `/workspace` is a host mount; no code was ever at risk.

Verified post-rebuild — every entry in `~/.coi/` timestamped 20:08–20:30, `sessions-claude/`
holding only the current session, `~/.coi/profiles/` absent entirely:

```
$ ls ~/.coi/sessions-claude/
1afdf68c-dd67-4b32-878b-e878e6e6262d      # only the session running at the time
$ ls ~/.coi/profiles/
(does not exist)
```

## The session-export finding

Stated separately because the runbook previously claimed the opposite, in both directions. Measured
by diffing the VM's `~/.coi` tree either side of a `coi shutdown` — the 19:18/19:20 snapshot, 5
files before, 468 after:

```
~/.coi/sessions-claude/<id>/.claude/projects/-workspace/<id>.jsonl   <-- the transcript
~/.coi/sessions-claude/<id>/.claude/history.jsonl
~/.coi/sessions-claude/<id>/.claude/file-history/<id>/...
~/.coi/sessions-claude/<id>/.claude/.credentials.json
~/.coi/sessions-claude/<id>/.claude/settings.json, CLAUDE.md, plugins/, backups/, cache/
```

Three separate facts:

1. **Export works.** The `coi shell` teardown (which the `coi shutdown` forced) writes the complete
   `~/.claude` tree. `metadata.json` appears in that directory at container *start*; the rest lands
   at teardown.
2. **Restore does not.** The next container starts with an empty `~/.claude/projects/-workspace/`.
   Nothing reads the export back in, so `--resume` never offers the old session. COI defect.
   (Superseded — see *Fix → Correction, 2026-09-07*.)
3. **The export target is VM-local** — per the table above.

Fact 3 is what actually cost the sessions. The feature worked; the storage location defeated it.

## Recovery — and where the procedure now lives

Zero to working took ~22 minutes (20:08–20:30) and had to be reconstructed live: **no such
procedure existed.** COI-SANDBOX documented *end states* ("Incus ≥ 6.1 required") but not the
commands, so it could not get you from a wiped VM to a shell.

That reconstruction is now the canonical setup path — **[COI-SANDBOX.md → *One-time
setup*](COI-SANDBOX.md)**, steps 1–11. It is deliberately not duplicated here; two copies of a
procedure drift, and the runbook is the one someone actually opens when rebuilding.

What this incident contributed to it, none of which was written down before:

- The Zabbly one-liner and the `incus version` pin.
- The `newgrp` propagation gotcha — `groups` says `incus-admin` while `coi health` still warns.
- **`sudo incus admin init` at all.** A fresh install has no storage pool and no bridge; everything
  downstream fails with `Failed getting root disk: No root device could be found` until it runs.
  This was the single biggest missing piece.
- The full prompt table with reasoning per answer, including `dir` vs `zfs`.
- That `--auto` is a dead end: `Failed to automatically find an unused IPv4 subnet, manual
  configuration required`, even though `ip addr`/`ip route` showed only Lima's `192.168.5.0/24`.
  Never diagnosed; specify the subnet explicitly.
- That subuid/subgid delegation is absent on a fresh VM (`grep root /etc/subuid /etc/subgid` empty).
- That `coi build`'s 5–10 min and its FORWARD-rules/netplan self-heal output are **normal**, so
  nobody kills it thinking it hung.
- That `coi trust` is required on a rebuilt `~/.coi/`, because port declarations start untrusted.
- The workspace re-verification (`ls /workspace`) promoted to a standing post-rebuild step.
- Step 10, `scripts/coi-vm-setup.sh` — it did not exist during this recovery, and its absence is why
  the losses above were permanent. (A step 12 / `coi-container-setup.sh` was added at the same time
  and **deleted on 2026-09-07** — see the correction below.)

## Storage decision — deferred, not decided

`coi health` flags it every run:

```
[WARN] Incus storage pools: default (dir): 'dir' storage driver re-unpacks the image on
  every launch — recreate the pool with a copy-on-write driver (zfs/btrfs)
```

Left as `dir`. `zfs` would remove the per-launch re-unpack and unlock `coi snapshot`
(checkpoint/rollback), at the cost of a DKMS compile — the exact delay this recovery was trying not
to repeat. Reasonable *under recovery pressure*; a bad way to make a standing decision. Open
follow-up, not a conclusion.

A stray `zfs-pool` was left behind by the aborted `--auto` attempt. Before deleting it, check
`incus storage volume list zfs-pool`, not just `incus list` — pool and container names survived the
rebuild identically, which makes a stale reference easy to misread as safe.

## Fix — two layers as built; one survives (see the correction below)

Both were idempotent, migrated rather than replaced, set the original aside rather than deleting,
refused rather than clobbering, and took `--check`. Both were deliberately **not** `lima.yaml`
edits: mount changes restart the VM (Incident B.1), and a typo in one is what caused this. Only the
VM half still exists.

| Script | Runs in | Fixes |
| --- | --- | --- |
| `scripts/coi-vm-setup.sh` | Lima VM | `~/.coi/sessions-claude` + `~/.coi/profiles` survive a VM rebuild |
| ~~`scripts/coi-container-setup.sh`~~ | container | **Deleted 2026-09-07** — see the correction below. It symlinked `~/.claude/projects` to the Mac, which made COI skip that directory at export time |

> **Correction, 2026-09-07 — "the export is not a restore" was wrong.** The teardown writes the
> complete `~/.claude` tree to `~/.coi/sessions-claude/<session-id>/`, and `coi shell --resume`
> reads it back into a fresh container. Measured across a real destroy/restore cycle: `incus list`
> empty, new container at `up 0 minutes`, and every transcript back byte-identical
> (`189,441 → 189,441`, `192,343 → 192,343`), plus `history.jsonl` (your `↑` prompt history),
> `settings.json`, `session-env/`, `file-history/` and `.credentials.json`. `claude --resume`
> offered the sessions and opened them with full context.
>
> The original conclusion came from a test that defined success as `claude --resume` working and
> never checked whether COI had its own resume; everything downstream was built on that. It
> survived scrutiny because the workaround built to fix it — a symlink from `~/.claude/projects`
> onto the repo mount — **caused** the symptom: COI does not follow that symlink at export time, so
> the restore could not be observed while the fix was installed. Deleting the symlink was the
> entire fix. `coi --help` would have settled it at the start. Same lesson as `findmnt` and
> `incus info` elsewhere in this file: **check the tool's own surface before concluding a
> capability is missing.**
>
> Two things the restore does not carry — `~/.claude.json` (comes back reset) and, untested,
> memory files — are logged in `COI-SANDBOX.md` → *Deferred / to-do* → *Session-restore leftovers*.
>
> A container here was also observed **frozen and unfrozen** between 00:28 and 11:19 on
> 2026-09-07, keeping its rootfs and a live transcript across the gap. Alive / deleted is not the
> whole set of states — check `uptime -p` before concluding a container is new.
>
> `scripts/coi-vm-setup.sh` is unaffected and matters more now — `~/.coi/` is VM-local, so it
> protects the store that `--resume` depends on. Procedure: `docs/ops/COI-SANDBOX.md` →
> *Run → Ending a session*.

The now-deleted second script existed because of a follow-on finding that still holds: **the export
only fires on `coi` teardown.** The Run 2 snapshot was taken after `Ctrl+D` and before
`coi shutdown`, and held only `metadata.json`; all 463 files appeared across the shutdown. The
original reading — "the export fires on `coi shutdown`" — was wrong: `Ctrl+D` only leaves Claude
Code, so `coi shell` was still running and no teardown had fired; the shutdown then killed the
container, which ended `coi shell`, which ran the teardown. Same observation, correct cause. So
exiting the TUI exports nothing, and neither does `limactl stop`, a Mac reboot, clamshell sleep
(Incident B), or a dropped terminal. **There is still no continuous backup** — that part was never
wrong. What was wrong was the remedy: the symlink cost more than the gap it covered. Current
guidance is `COI-SANDBOX.md` → *Known failure modes*, row "Session lost after a crash / reboot /
lid-close": exit `coi shell` at every real break — that teardown, not `coi shutdown`, is what
exports — and if it ever bites for real use `CLAUDE_CONFIG_DIR`.

Wired into COI-SANDBOX *One-time setup* as step 10. Step 12 was the container half, removed
2026-09-07 — it survives only as a do-not-do note.

## Ruled out — don't re-explore

- **"Nothing is exported."** The original prediction, and wrong. `findmnt` inside the container
  can't see the export because it happens at the `coi` level, outside the container.
- **Mounting `~/.claude/projects` out of the container.** Unnecessary — COI already exports it.
  Capture was never the problem; durability was.
- **`persistent = true` as *the* fix.** A stopgap only; container state is also on the VM disk, so
  the next rebuild takes it too, and it does not reliably preserve the rootfs either. Not
  load-bearing in either direction — see *Open follow-ups* (the answered `persistent = true` bullet).
- **"No data loss occurred."** The original write-up's headline, based on assuming `~/.coi/` was on
  the Mac. It wasn't.

## Open follow-ups

- Does `coi` recreate `sessions-claude`/`profiles` with `mkdir -p` (symlink survives) or replace them
  outright (it doesn't)? `scripts/coi-vm-setup.sh --check` after a shutdown cycle answers it. If it
  replaces them, this becomes a per-session step, not one-time.
- **Does `persistent = true` suppress the session export?** COI writes `"persistent": true` into the
  session's `metadata.json`, so it is a decision input somewhere, and a persistent container is
  never torn down. Every export measured here (the 5 → 468 diff) came from an *ephemeral* container.
  If the next shutdown leaves only `metadata.json` on the Mac side, the answer is yes — and the
  right response is to revert to `persistent = false`, since that flag was only a stopgap for the
  durability problem step 10 now solves. **Answered 2026-09-07: no.** Both observed exports
  record `"persistent": true` and are complete, so the flag does not suppress the export. And
  `coi shutdown --help` settles the other half: that command **deletes a persistent container
  outright** — persistence only survives powering off from inside or exiting `coi shell`. Since
  `--resume` rebuilds a deleted container from its export, reverting to `persistent = false` is
  close to free.
- Recreate the `aperture-night` profile.
- Generate and commit an `incus admin init` preseed so the next rebuild is one command.
- Decide `dir` vs `zfs` deliberately, off the critical path.
- ~~File the restore defect upstream with COI.~~ **Withdrawn 2026-09-07** — there is no restore
  defect; see the correction above. The `coi audit` read-path defect is unrelated and still stands.
- `.credentials.json` rides along in the export, so it now lands on the Mac disk under gitignored
  `localNotes/coi-state/` (mode 700). COI's "host cred isolation" check does not cover this
  direction — it only checks host creds don't leak *into* containers.

---

# Incident E — a HIGH threat pause that was Claude Code starting up

**2026-09-06, 20:33.** Two minutes into the first `coi shell` on the rebuilt VM.

## Symptom

Terminal output froze, and:

```
*** SECURITY: Container coi-88cded0c-1 PAUSED due to security threat.
    Unfreeze with: coi unfreeze coi-88cded0c-1 ***
```

`coi list` confirmed status `Frozen`.

## The diagnostic dead end — `coi audit` returned nothing

```bash
coi audit coi-88cded0c-1        # empty output
```

Empty, despite `coi list` confirming the exact container name and its frozen state. This matched a
known runbook to-do ("audit log is live-only, no on-disk history"), so the working assumption became
*no record exists*. **That assumption was wrong and cost time.** Also dry:
`sudo journalctl -u incus --since "5 min ago"` showed only an unrelated DHCP lease line.

## The fix — go around the CLI, straight to the file

```bash
find ~/.coi -iname "*audit*" -o -iname "*.jsonl"
# /home/<user>.guest/.coi/audit/coi-88cded0c-1.jsonl
# /home/<user>.guest/.coi/audit/coi-88cded0c-1-nft.jsonl
```

The file existed and was **fully populated** — per-poll JSON Lines telemetry (network connections,
process list, filesystem read/write rates, resource usage) sampled every ~2s for the container's
entire lifetime, including the event:

```json
{
  "timestamp": "2026-09-06T20:33:13.036...",
  "level": "high",
  "category": "filesystem",
  "title": "Large workspace read detected",
  "description": "Read 32.45 MB at 16.00 MB/sec (threshold: 10.00 MB)",
  "evidence": { "filesystem": {
    "read_bytes_mb": 32.4453125,
    "read_rate_mb_per_sec": 15.9992890555453,
    "files_read": 0,
    "duration": "sustained",
    "threshold_mb": 10
  }},
  "action": "pending"
}
```

followed immediately by the same event with `"action":"paused"`.

## Assessment — false positive

- **`files_read: 0`.** A sustained 32 MB read at ~16 MB/s that the monitor could not attribute to
  any specific file. Consistent with interpreter/tool startup I/O — project files, config,
  dependency manifests — not a targeted read.
- **Timing.** Fired essentially at Claude Code's own process start in the tmux session, i.e. early
  session indexing, not mid-task behaviour.
- **No correlated network anomaly.** Active connections at that timestamp were unchanged from
  steady state (existing HTTPS to Anthropic API infrastructure). Nothing new outbound.
- **Network mode was `restricted`, not `allowlist`** — so this was not the already-known-noisy
  allowlist-violation trigger. A distinct detector (`file_read_rate_mb_per_sec`) fired on its own.

`coi unfreeze coi-88cded0c-1`. No recurrence that session.

## Two distinct root causes

1. **The `file_read_rate_mb_per_sec` / `file_read_threshold_mb` detector has no startup grace
   period.** `.coi/config.toml` sets `file_read_threshold_mb = 50` and
   `file_read_rate_mb_per_sec = 10` — sane steady-state values that legitimate session-start
   indexing exceeds. Working as configured, but a detector that pauses the container on a schedule
   trains you to reflexively unfreeze, which is how a real one gets waved through. Tune it or add
   the grace period; "expect a freeze on launch" is the wrong fix.

   The same detector froze a later session on `pnpm install`; the source findings (the two keys
   also drive the **write** detector), ceiling measurements and the levers that do not exist are
   under *Second freeze — `pnpm install`, 2026-09-07* below. Tuning config: `COI-SANDBOX.md` →
   *Container frozen — find out what tripped it*.
2. **`coi audit <name>` does not reliably surface events that are present in
   `~/.coi/audit/<name>.jsonl`.** A genuine CLI defect, and more specific than the runbook's older,
   broader worry that there is *no* on-disk history. There **is** on-disk history, complete and
   legible. The read-path is what's unreliable. Correct the framing wherever it appears.

## Corrected diagnostic procedure

```bash
coi list                                       # exact container name + Frozen status
find ~/.coi -iname "*audit*"                   # go to the file directly; don't wait for coi audit to fail
tail -50 ~/.coi/audit/<container>.jsonl
grep '"level":"high"' ~/.coi/audit/<container>.jsonl
```

Use `coi audit <name> -f` for *live* monitoring only — not as the first tool for investigating a
pause that already happened.

## Second freeze — `pnpm install`, 2026-09-07

The same detector froze a later session the moment `pnpm install` ran. Reading the `processes`
list embedded in the audit record (the procedure in `COI-SANDBOX.md` → *Container frozen — find out
what tripped it*) named `CI=true corepack pnpm install` — not the agent work it was blamed on.
Attribute before you theorise. The verdicts:

```
Large workspace write detected: Write 127.54 MB at 61.30 MB/sec (threshold: 50.00 MB)   → paused
Large workspace write detected: Write  26.43 MB at 13.21 MB/sec (threshold: 10.00 MB)   → logged (already paused)
```

### Five things read from source

Not obvious from the log — all read out of COI's source (`localNotes/code-on-incus`, commit
`d304121`) on 2026-09-07:

**"workspace" in the title is a hardcoded string, and it is wrong.** The measurement is cgroup v2
`io.stat` `wbytes` read at the container's *top-level* cgroup (`internal/monitor/cgroup.go:224-237`),
so it counts **all block I/O by every process in the container**. There is no path filtering
anywhere in the detection path — `WorkspacePath` is set on the snapshot and read by nothing. A
`docker build`, an `apt-get install`, or heavy swap writeback trips it exactly the same way.

**The write detector has no config keys — it borrows the read ones.**
`internal/monitor/detector.go:21-29`:

```go
func NewDetector(fileReadThresholdMB, fileReadRateMBPerSec float64) *Detector {
	return &Detector{
		fileReadThresholdMB:   fileReadThresholdMB,
		fileReadRateMBPerSec:  fileReadRateMBPerSec,
		fileWriteThresholdMB:  fileReadThresholdMB,  // Default: same as read threshold
		fileWriteRateMBPerSec: fileReadRateMBPerSec, // Default: same as read rate threshold
```

`NewDetector` copies the two read keys into `fileWriteThresholdMB` / `fileWriteRateMBPerSec`; there
is no `file_write_*` key. The comment says "Default:", implying an override. **There is none** — no
`WithFileWriteThreshold` setter exists, though `WithProcessCountThreshold` and `WithProcessSpawnRateThreshold` do. The
`FileWriteThresholdMB` / `FileWriteRateMBPerSec` fields on `DaemonConfig`
(`internal/monitor/types.go:229-230`) are vestigial: never written, never read. Don't chase them.

**50 and 10 are COI's shipped defaults**, in `internal/config/embedded/default_config.toml:107-115`.
Our config sets the same numbers, which is why the write verdicts looked like they were echoing
hardcoded constants. They weren't — we had copied the defaults.

**The two thresholds are the same check.** Both derive from one per-poll delta
(`internal/monitor/filesystem.go:50-66`): `TotalWriteMB` is bytes since the last poll, and
`WriteRateMBPerSec` is that same delta over measured elapsed time. So
`rate = burst / poll_interval_sec` — they are perfectly correlated, and **whichever threshold is
lower always binds while the other never fires.** You are really picking one number:

```
file_read_rate_mb_per_sec = <MB/s ceiling>
file_read_threshold_mb    = <ceiling> × poll_interval_sec
```

Only one verdict fires per poll (`DetectLargeWrites`, `filesystem.go:142-166`, returns early). The
burst branch reports `duration: "current interval"`; the rate branch reports `"sustained"` — and on
that branch the JSON field named `threshold_mb` is carrying a **MB/sec** value. Misnomer in the
log, not a bug in your reading. Also: **raising `poll_interval_sec` makes the burst check worse**, a
longer window accumulating more MB against the same MB bar.

**No grace period, no process or path exemption, and `enabled = false` is all-or-nothing** — the
full list of levers checked is at the end of this section.

### Write ceiling — can the detector fire at all?

**A threshold above the container's real write ceiling can never fire — that is
`enabled = false` with extra steps.** Measured on this rig, 2026-09-07, **inside the container**
(`/tmp` is the rootfs; `/workspace` is virtiofs to the Mac):

| Target | Path | Speed |
| --- | --- | --- |
| container rootfs | `/tmp` (ext4, `/dev/vda1`) | **2.6 GB/s** |
| virtiofs to the Mac | `/workspace/localNotes` | **1.2 GB/s** |

```bash
# keep count under file_read_threshold_mb or the test freezes you — 300 against a 500 bar
dd if=/dev/zero of=/tmp/wtest bs=1M count=300 conv=fdatasync; rm -f /tmp/wtest
```

Both are upper bounds — `conv=fdatasync` flushes the guest's view but the Mac's page cache still
buffers underneath. Good enough for the question that matters: the ceiling is 5–10x the 250 MB/s
threshold, so the detector can actually fire. For scale: `pnpm install` runs at **61 MB/s**, far
under the raw ceiling, because it is network-bound and writes thousands of small files rather
than a sequential stream.

### Writes to `/workspace` are invisible to this detector

Measured 2026-09-07: two 300 MB writes seconds apart, one to `/tmp` (rootfs) and one to
`/workspace/localNotes` (virtiofs). Only **one** 300 MB spike appears in the audit log. Since rootfs
writes provably count — a 2 GB `/tmp` write produced a verdict — the one that vanished is the
virtiofs write. Confirmed with a second 400 MB virtiofs write that also left no trace.

The mechanism fits: the detector reads cgroup v2 `io.stat` `wbytes`, which counts **block-device**
I/O. Writes to `/workspace` cross virtiofs to the host, where the actual block I/O happens on the
Mac. Editing files, `vite build`, and `node_modules` itself are free — they can never trip it. And
whatever `pnpm install` writes into `/workspace` is invisible too.

> **Corrected 2026-09-07 (same day).** An earlier version of this paragraph blamed the freeze on
> "pnpm's content-addressable store on the rootfs." That was asserted without checking, and it is
> wrong on both halves: `pnpm store path` resolves to **`/workspace/.pnpm-store/v11`**
> (`pnpm config get store-dir` prints `undefined` on pnpm 11.18.0), `dev=45` — virtiofs, i.e.
> exactly the filesystem that is invisible here. The store is not the source and never was.
>
> What *is* on the rootfs during an install: `TMPDIR` is unset, so pnpm extracts tarballs through
> **`/tmp`** (`dev=64769`), and corepack caches package-manager downloads in `~/.cache/node/corepack`
> (also rootfs). Temp extraction is the strongest candidate for the counted I/O — **inference from
> the filesystem layout, not a measurement.** If it matters, the way to settle it is to set `TMPDIR`
> to a `/workspace` path and see whether the write volume vanishes from the audit log.
>
> Related, and worth knowing separately: on this mount pnpm's files are **copies, not hardlinks**
> into the store (sampled link counts are all `1`, and store + `node_modules` ≈ 452M + 479M). It is
> not a virtiofs limitation — hardlinks tested fine there directly. So an install moves the full
> byte volume rather than just linking, which is why it registers at all.

This makes the "Large workspace write detected" title doubly wrong: not only is it a hardcoded
label with no path filtering behind it, the workspace is the one thing it cannot observe.

### Config-change readback

Tripping the detector deliberately (the 2000 MB `dd` in `COI-SANDBOX.md` → *Container frozen*)
after raising 50 → 500, observed 2026-09-07:
`"description":"Write 2000.00 MB at 989.50 MB/sec (threshold: 500.00 MB)"` — the verdict echoes
**500**, so the edit landed. Still `50` would mean it hadn't. Note `2000 / 989.50 = 2.02s`, exactly
one `poll_interval_sec`, confirming the delta-per-poll model. Then `coi unfreeze <name>`.

### Levers that do not exist

Checked, so nobody re-derives them:

| Idea | Reality |
| --- | --- |
| Set the keys to `0` to disable | `internal/config/merge.go:144-149` treats zero as "not set", so the 50/10 defaults win |
| Exempt `pnpm install` by process or path | No allowlist, no path exemption, no startup grace period on this detector. (The 30s grace in `filewatcher.go:183-185` belongs to the inotify secret-file watcher — different component) |
| Disable just the filesystem detector | `enabled = false` is all-or-nothing (`internal/cli/monitoring.go:34`) — kills process, network, log and file watchers with it. No per-category switch exists |
| An env var or CLI flag | None. The config layer reads only `COI_CONFIG` (a path); `coi monitor` has no threshold flags |
| Validation blocking a big value | The `>10GB` check is a soft health-report warning; `internal/config/validate.go` has no monitoring validation at all |
| `[limits.disk]` read/write | A different mechanism — a cgroup blkio *throttle*, not the detector. Capping writes below 10 MB/s to dodge the alert would make installs take minutes |

### Why the second verdict said `logged (already paused)`

`r.paused` is set true at `responder.go:191,199` and **never reset**. After `coi unfreeze`, that
daemon still believes the container is paused, so further HIGH threats are logged rather than
acted on — convenient for finishing the session, but a fresh `coi shell` starts a fresh responder
with `paused = false` and will freeze you again on the next big install. Fix the config; don't
rely on this.

## What went right (both incidents)

- `coi health` caught real configuration gaps — group reload, missing `libsystemd-dev`, the storage
  tradeoff — before they became live-session problems.
- `coi build` self-healed a fresh-bridge race (missing FORWARD rules, then netplan DHCP fallback).
- The workspace scoping was re-verified before the environment was trusted, reusing the exact check
  that had caught the original full-home mount.
- Host-credential isolation held throughout; no host secret reached a container.
- The audit telemetry pipeline is sound. Only its CLI read-path is not.

---

# Incident F — three container kills from `python3 -c`

**2026-09-07, 11:58 / 13:02 / 13:12.** Level **CRITICAL**, category `process`, title
*"Reverse shell detected"*, action `killed`. No attack occurred; nothing was compromised.

## What actually ran

| Time | Command | Session |
| --- | --- | --- |
| 11:58:40 | `gh api repos/aws/aws-cdk/pulls/32369 \| python3 -c "…print('merged_at:', …)"` | CDK/auth work |
| 13:02:29 | `npm view aws-cdk-lib versions --json \| python3 -c "…print(v[-5:])"` | CDK/auth work |
| 13:12:00 | a test harness for the guard hook, carrying `nc -e …` and `python3 -c` as **fixture strings** | this session |

The third is the instructive one: writing a *test* for the protection tripped the thing it protects
against, because the patterns were on the bash command line rather than in a file.

## Mechanism

- `internal/monitor/process.go:249-290` — a **hardcoded** pattern list, matched with
  `strings.Contains` against each process's lowercased command line (full list:
  `COI-SANDBOX.md` → *Container killed — the CRITICAL path is a different animal*). No config key
  edits it; `coi schema profile` exposes nothing for it.
- `process.go:298-302` — the false-positive gate:

  ```go
  isNetworkRelated := strings.Contains(cmdLower, ":") ||
      strings.Contains(cmdLower, "sock") || strings.Contains(cmdLower, "tcp") || ...
  if isNetworkRelated || pattern.pattern == "bash -i" || pattern.pattern == "sh -i" {
  ```

  (the elided tail is `"udp"` and an IP pattern). **Any colon anywhere.** A dict, a Python slice
  (`v[-5:]`, `s[11:19]`), a URL, a timestamp. Every realistic JSON one-liner matches. `bash -i` /
  `sh -i` bypass the gate and always fire.
- `internal/monitor/responder.go:137-147` — `ThreatLevelCritical` + `auto_kill_on_critical` →
  `killContainer()`.
  **No dedupe latch**, unlike HIGH's `r.paused`, so it recurs on every match.
- Sampling is per `poll_interval_sec` (2s). Fast one-liners often slip between samples; ones blocked
  on a slow pipe (`gh api`, `npm view`) are reliably caught. Prior successes were timing, not safety.

## Assessment — false positive, and a costly detector

`python3 -c` piped from a package registry or the GitHub API is ordinary development. The gate is
supposed to separate "one-liner" from "one-liner opening a socket", and a substring test for `:`
cannot do that. Worse, the repo's own `CLAUDE.md` rule — *"always check the registry for the actual
latest version — `npm view <pkg> version`"* — leads directly to the shape that kills the box.

Severity is asymmetric: a HIGH false positive costs an unfreeze, a CRITICAL one destroys the
container.

## Fix — don't emit the shape; don't disarm the monitor

`auto_kill_on_critical = false` would stop the kills and was rejected: it is the sandbox's whole
point, and it would also disarm the network CRITICALs that matter. The pattern list is compiled in,
so there is nothing to tune. So:

1. **`.claude/hooks/coi-reverse-shell-guard.sh`** — `PreToolUse` on Bash, denies these shapes before
   they run (behaviour and the substitution table: `COI-SANDBOX.md` → *Container killed*).
2. **A `CLAUDE.md` rule**, so the constraint survives the hook being unregistered: use
   `python3 - <<'PY' … PY` (runs as `python3 -`, unmatched) or `jq`.

## Worth filing upstream

Two defects, both narrow:

- **The `:` heuristic is not a network test.** Requiring an actual socket indicator — an IP, a port,
  `socket`, `connect` — would remove essentially every false positive here without weakening real
  detection.
- **CRITICAL has no dedupe latch** while HIGH does (`responder.go` `r.paused`). One benign pattern in
  a loop kills the container repeatedly.

Unrelated to the `coi audit` read-path defect in Incident E; both stand.

---

# Incident G — 2026-09-07: forks on every resume; dotfiles that evaporate

**2026-09-07, afternoon.** An afternoon of `.coi/config.toml` iteration, each change needing a new
container, surfaced two container-lifecycle costs that had been misattributed. Neither is a COI
defect. The procedures live in `COI-SANDBOX.md` → *Start here → 1*; the evidence is here.

## G.1 Session forks

**Every resume forks the session.** Claude Code's background-session daemon relaunches with
`--fork-session --resume <transcript>`, minting a **new session id** rather than continuing the old
one. The old id stays in the `claude --resume` picker forever, and since the forks share an
ai-title the picker disambiguates them `(1)`, `(2)`, `(3)`… Worse, several forks stay live under
the same daemon, so one message fans out to all of them and you have to stop the extras by hand.

Seven accumulated here on 2026-09-07 during an afternoon of `.coi/config.toml` iteration, purely
because each config change needed a new container. **COI is not the cause** — `--fork-session`
appears nowhere in its source; `internal/tool/tool.go:133-135` emits a plain `claude --resume`.
Using `coi attach` avoids the resume, and so avoids the fork.

To clean up an existing pile, move the stale transcripts out of
`~/.claude/projects/-workspace/` (the picker lists that directory). Identify the live one by
**content**, not by `ps`: an `--agent` sidecar shows a `--session-id` with no transcript at all
and will mislead you. Grep the candidates for your most recent message and check each stale
transcript's final message is already contained in the survivor.

## G.2 Container-local dotfiles

The export is exactly `~/.claude/` plus `metadata.json` — verified by listing the export trees;
nothing else from `$HOME` is in there — so anything configured in a container-local dotfile
evaporates with the container. Two instances, same day:

**Git identity — bit twice on 2026-09-07.** The image ships `~/.gitconfig` with
`useConfigOnly = true` and no name/email (deliberate — it stops an agent committing as
`code@coi-88cded0c-1`), so commits fail until an identity is set, and a `--global` fix inside the
container dies with it. The fix is repo-local (`git config --local user.name` / `user.email`, run
on the Mac because `.git/config` is a read-only mount in the container). Verified by pointing
`GIT_CONFIG_GLOBAL` at a bare image-default gitconfig: identity still resolves, and stripping
`[user]` from the repo makes it fail — so the repo file is genuinely carrying it.

**mise shadowing the repo's toolchain.** `~/.config/mise/` and `~/.local/share/mise/` are on the
rootfs, and the image ships mise configured with `"npm:pnpm" = "latest"` — which shadows corepack
on `PATH`, and "latest" is a different major from the `packageManager` field CI reads. The image
ships the same conflict three times; `typescript` and `tsx` were shadowed too. Resolved 2026-09-07
by uninstalling all three, leaving mise owning only what the repo *doesn't* declare:

| | Repo declares | mise shipped | now resolves to |
| --- | --- | --- | --- |
| `pnpm` | `packageManager` → 11.18.0 | "latest" → 12.3.4 | corepack, 11.18.0 |
| `typescript` | 6.0.3, root + all 5 packages | "latest" → **7.0.2** (a major apart) | repo, 6.0.3 |
| `tsx` | 4.23.5, cdk + scripts | "latest" → 4.23.13 | repo, 4.23.5 |
| `python` | *nothing* | 3.x | mise — correctly |

Bare `tsc` and `tsx` stop existing, which is the point — nothing should invoke them outside a
project. Verified nothing did: `scripts/package.json` runs `tsx src/smoke.ts` as a pnpm script and
`deploy.yml` uses `pnpm --filter @aperture/scripts exec tsx`, both resolving via
`node_modules/.bin`.
