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

---

# Incident A — `SIGABRT (134)` when starting a second session

**TL;DR:** Not memory, not a Claude Code bug. The container's pids cgroup ceiling
(`limits.processes`, templated to `300` by coi) was saturated at ~295. A second session needs ~15
more threads, `clone()` returns `EAGAIN`, and the runtime `abort()`s. Fix: raise `max_processes` to
`1024` in `.coi/config.toml`.

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
max_processes = 1024   # was 300

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

If the limit doesn't take, a profile is overriding it:
```bash
incus config get <ctr> limits.processes             # instance level
incus config show <ctr> --expanded | grep processes # effective
incus profile show <profile> | grep processes       # set it here if instance-level is ignored
```

### Cleanup worth doing anyway

- **snapd — 45 threads of nothing.** Nothing in this stack consumes snaps, and snapd forks
  constantly (it was itself being refused). `systemctl disable --now snapd snapd.socket snapd.seeded`
  would alone have gotten the container under 300. Raise the limit regardless.
- **Docker-in-Incus** idles at ~24 threads (in-container count). Fine if you need image builds; stop
  it when you don't.

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

At ~15 threads per foreground session plus a browser and a dev server, **300 only ever budgeted for
one session.** Even 2048 is tight for four sessions plus a build. `1024` is a sane floor; `8192` is
not extravagant.

### Open follow-ups

- [x] `max_processes` 300 → 1024 in `.coi/config.toml`
- [ ] Disable snapd in the container image
- [ ] Decide whether dockerd should run persistently or only during builds
- [ ] Trim MCP servers per-session — they multiply N×M with no dedup

---

# Incident B — a 13-hour unattended run died, and left the terminal broken

Written up after a 2026-08-21/22 debugging session that cost several hours. Everything here is
**log-backed where a log line is quoted; inferences are labelled as such** — the distinction
matters, because the point of this page is to still be trustworthy months from now. Dead ends are
recorded deliberately so they aren't re-explored. Applies to **any** COI project, not just Aperture.

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
> character-for-character the **Lima** form from *One-time setup → step 3* (`limactl edit incus`).
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
| nft monitor auto-pause/kill | **Unprovable** | `auto_kill_on_critical=true` *was* live (daytime profile), but `coi audit` keeps no history. Container was `RUNNING` and auto-pause pauses rather than kills, so unlikely. |
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
