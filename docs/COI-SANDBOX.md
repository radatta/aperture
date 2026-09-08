# Aperture on code-on-incus (COI) — sandbox runbook

Run Claude Code against this repo inside an **Incus system container** — as a day-to-day dev
environment *and* an unattended overnight rig (`--dangerously-skip-permissions`). The container,
not Claude's own Bash sandbox, is the isolation boundary. Two profiles off one base config.

Posture, either profile: **code / test / build only — no local deploy, no AWS creds.** Deploys run
through CI on a branch push; local `cdk deploy` is off-path and the harness (`.claude/hooks`) blocks
pushes to `main`/`dev` regardless.

Built + verified on an Apple-silicon Mac, 2026-08-10/11.

---

## Start here — the four things you ever do

You are always doing exactly one of these. There are three layers (Mac → Lima VM → container) and
almost every mistake is running a command at the wrong one.

**Container name for this repo is `coi-88cded0c-1`** — derived from the workspace path, so it's
stable. `incus list` prints it if you doubt that.

### 1. I want to use Claude

```bash
# ── on the Mac ──
cd ~/Coding/Personal/aperture
limactl shell incus                       # → you are now in the Lima VM

# ── in the VM ──  (prompt: rahuldatta@lima-incus:...)
incus list                                # is the container still there and Running?

#   Running  → reattach. Claude is still alive in tmux; nothing restarts.
coi attach

#   Gone     → rebuild it from the export, then pick your session in the container.
ls ~/.coi/ && ./scripts/coi-vm-setup.sh --check    # both pass 9/10 times → skip to the next line
coi shell --resume                        # → you are now in the container
claude --resume                           # (prompt: code@coi-88cded0c-1) pick your session
```

**Reach for `coi attach` first — it is the normal case.** A persistent container is *kept running*
when you leave (`internal/session/cleanup.go:305-315` even prints "use 'coi attach' to reconnect"),
so the `claude` process and its tmux session survive. `coi attach` is `tmux attach -t <session>`
(`internal/cli/attach.go:160`) — you land back in the same conversation, and nothing resumes.

**`coi shell --resume` is for when the container is gone**, after a `coi shutdown` or a VM rebuild.
It rebuilds from `~/.coi/sessions-claude/` and your transcripts, prompt history (`↑`), settings and
statusline all come back — verified 2026-09-07, see *Ending a session*. Never bare `coi shell`: on a
torn-down container that gives you an empty box.

> **Why the distinction is worth caring about: every resume forks the session.** Claude Code's
> background-session daemon relaunches with `--fork-session --resume <transcript>`, minting a **new
> session id** rather than continuing the old one. The old id stays in the `claude --resume` picker
> forever, and since the forks share an ai-title the picker disambiguates them `(1)`, `(2)`, `(3)`…
> Worse, several forks stay live under the same daemon, so one message fans out to all of them and
> you have to stop the extras by hand.
>
> Seven accumulated here on 2026-09-07 during an afternoon of `.coi/config.toml` iteration, purely
> because each config change needed a new container. **COI is not the cause** — `--fork-session`
> appears nowhere in its source; `internal/tool/tool.go:133-135` emits a plain `claude --resume`.
> Using `coi attach` avoids the resume, and so avoids the fork.
>
> To clean up an existing pile, move the stale transcripts out of
> `~/.claude/projects/-workspace/` (the picker lists that directory). Identify the live one by
> **content**, not by `ps`: an `--agent` sidecar shows a `--session-id` with no transcript at all
> and will mislead you. Grep the candidates for your most recent message and check each stale
> transcript's final message is already contained in the survivor.

**If either check on that third line fails**, you're on a fresh Mac or a rebuilt VM. Go do
*One-time setup* below (~20 min, mostly `coi build`), then come back. `ls ~/.coi/` failing means no
COI state at all; `coi-vm-setup.sh --check` failing means `~/.coi/` exists but isn't mirrored to Mac
disk, which is the one that quietly costs you sessions on the next VM rebuild.

> **Anything you configure inside the container, outside `~/.claude`, is gone on the next rebuild.**
> The export is exactly `~/.claude/` plus `metadata.json` — verified by listing the export trees;
> nothing else from `$HOME` is in there. So a `git config --global`, a `~/.bashrc` line, an
> `npm config set`, a `mise use --global`, an `apt-get install` — all of it evaporates the next time
> the container is recreated, and you find out at the moment you need it.
>
> Put durable config where it already lives on Mac disk. The worked example is **git identity**,
> which bit twice on 2026-09-07: the image ships `~/.gitconfig` with `useConfigOnly = true` and no
> name/email (deliberate — it stops an agent committing as `code@coi-88cded0c-1`), so commits fail
> until you set one, and a `--global` fix inside the container dies with it. The fix is repo-local,
> run **on the Mac** (`.git/config` is a read-only mount inside the container):
>
> ```bash
> git config --local user.name  "Rahul Datta"
> git config --local user.email "rahul3datta@gmail.com"
> ```
>
> `.git/config` lives on Mac disk and is mounted into every container, so there is nothing to
> restore. It satisfies `useConfigOnly` properly rather than disabling it. Verified by pointing
> `GIT_CONFIG_GLOBAL` at a bare image-default gitconfig: identity still resolves, and stripping
> `[user]` from the repo makes it fail — so the repo file is genuinely carrying it.
>
> Same reasoning applies to the toolchain: `~/.config/mise/` and `~/.local/share/mise/` are on the
> rootfs. The image ships mise configured with `"npm:pnpm" = "latest"`, which is wrong for this repo
> twice over — it shadows corepack on `PATH`, and "latest" is a different major from the
> `packageManager` field CI reads. **pnpm's version belongs to the repo, not the machine**
> (`CLAUDE.md` → *Conventions*). Undo it per container:
>
> ```bash
> # remove the `"npm:pnpm" = "latest"` line from ~/.config/mise/config.toml, then:
> /usr/local/bin/mise prune    # full path: mise is a shell function, absent in non-interactive shells
> sudo corepack enable         # ~/.local/bin is not on PATH here, so the no-sudo variant won't help
> command -v pnpm && pnpm -v   # expect /usr/bin/pnpm and the packageManager version
> ```
>
> **The image ships the same conflict three times.** `typescript` and `tsx` were shadowed too —
> resolved 2026-09-07 by uninstalling all three, leaving mise owning only what the repo *doesn't*
> declare:
>
> | | Repo declares | mise shipped | now resolves to |
> | --- | --- | --- | --- |
> | `pnpm` | `packageManager` → 11.18.0 | "latest" → 12.3.4 | corepack, 11.18.0 |
> | `typescript` | 6.0.3, root + all 5 packages | "latest" → **7.0.2** (a major apart) | repo, 6.0.3 |
> | `tsx` | 4.23.5, cdk + scripts | "latest" → 4.23.13 | repo, 4.23.5 |
> | `python` | *nothing* | 3.x | mise — correctly |
>
> ```bash
> /usr/local/bin/mise uninstall npm:typescript npm:tsx   # `prune` is NOT enough — it does not
>                                                        # uninstall tools dropped from config
> ```
>
> Bare `tsc` and `tsx` stop existing, which is the point — nothing should invoke them outside a
> project. Verified nothing did: `scripts/package.json` runs `tsx src/smoke.ts` as a pnpm script and
> `deploy.yml` uses `pnpm --filter @aperture/scripts exec tsx`, both resolving via
> `node_modules/.bin`.
>
> If something needs to survive rebuilds, it belongs in the image (`[container.build]`, see
> *Deferred*) or on the repo mount — never in a container-local dotfile.

### 2. I want to debug at the VM layer

Container won't start, ports are wrong, `~/.coi/` looks off, a session didn't come back:

```bash
cd ~/Coding/Personal/aperture && limactl shell incus

incus list                                # is the container there, and Running/Frozen/gone?
coi list
ls -lt ~/.coi/sessions-claude/            # what COI actually saved, newest first
grep '"level":"high"' ~/.coi/audit/coi-88cded0c-1.jsonl    # threat pauses (`coi audit` under-reports)
coi unfreeze coi-88cded0c-1               # container stuck Frozen
```

**A session didn't come back — look at the export before resuming.** Between `coi shutdown` and
`coi shell --resume` the container is gone and nothing has been restored yet. That window separates
*"COI never exported it"* from *"COI exported it and the restore failed"*, which have different
fixes:

```bash
NEW=$(ls -t ~/.coi/sessions-claude/ | head -1)
ls -l  ~/.coi/sessions-claude/$NEW/.claude/projects/-workspace/   # transcripts present?
find   ~/.coi/sessions-claude/$NEW -type l -printf '%p -> %l\n'   # symlinks are NOT followed at export
```

Transcripts present → the export is fine. Absent, with a symlink showing → that's the failure mode
*One-time setup* step 12 describes.

**`coi` and `incus` only exist here.** Typing them inside the container is the single most common
wrong-layer mistake — they aren't on `PATH`, so the line echoes back mangled with no error worth
reading. One-line test either way: **`ls ~/.coi/` works → VM. Fails → container.**

#### Container frozen — find out what tripped it

Your terminal goes dead mid-session and you get:

```
*** SECURITY: Container coi-88cded0c-1 PAUSED due to security threat.
    Unfreeze with: coi unfreeze coi-88cded0c-1 ***
```

**Do not start with `coi audit`.** It has a read-path defect — it returned *empty output* for a
container whose on-disk log was fully populated, and believing "there is no history" cost hours
(Incident E). `coi audit -f <name>` is for watching a live session, not investigating a pause that
already happened.

**Go straight to the file.** Complete per-poll telemetry — connections, processes, filesystem
rates, resource usage, every threat verdict — is written every ~2s for the container's whole
lifetime:

```bash
coi list                                          # exact name + confirm status Frozen
A=~/.coi/audit/coi-88cded0c-1.jsonl               # -nft.jsonl alongside it = network layer
grep '"level":"high"' "$A" | tail -5
```

Each verdict appears **twice** — once with `"action":"pending"`, then again as `"action":"paused"`.
Pretty-print the last one and read its `evidence` block:

```bash
grep '"level":"high"' "$A" | tail -1 | python3 -m json.tool
```

```json
{ "timestamp": "2026-09-06T20:33:13.036…", "level": "high", "category": "filesystem",
  "title": "Large workspace read detected",
  "description": "Read 32.45 MB at 16.00 MB/sec (threshold: 10.00 MB)",
  "evidence": { "filesystem": {
      "read_bytes_mb": 32.44, "read_rate_mb_per_sec": 15.99,
      "files_read": 0, "duration": "sustained", "threshold_mb": 10 }},
  "action": "paused" }
```

**Name the process that did it — this is the step that ends most investigations.** The audit
record is not just the verdict: each poll embeds the container's whole `processes` list at that
timestamp. So you can read off the exact command:

```bash
# NOTE the second grep. Two record shapes match '"level":"high"': the full poll record
# (carries filesystem + processes + a threats[] array) and a standalone threat record
# (id / evidence / action, NO processes). Without it, tail -1 lands on the latter and
# prints nothing.
grep '"level":"high"' "$A" | grep '"processes"' | tail -1 | python3 -c '
import sys, json
d = json.load(sys.stdin)
for p in d.get("processes", {}).get("processes", []):
    print(p["pid"], p["command"][:120])'
```

Write volume per poll, to see a spike without waiting for a verdict:

```bash
tail -60 "$A" | python3 -c '
import sys, json
for l in sys.stdin:
    d = json.loads(l)
    fs = d.get("filesystem") or {}
    w = fs.get("total_write_mb", 0)
    if w > 5:
        print(d["timestamp"][11:19], "%8.1f MB  %8.1f MB/s" % (w, fs.get("write_rate_mb_per_sec", 0)))'
```

On 2026-09-07 that named `CI=true corepack pnpm install` — not the agent work it was blamed on.
**Attribute before you theorise.**

**Triage — is it real?** Four checks, in this order:

| Check | Benign | Worth investigating |
| --- | --- | --- |
| `category` | `filesystem` | `network` — an actual egress verdict |
| The process list at that timestamp | a build, install, or test you started (`pnpm install`, `vite build`, `tsc`) | nothing that explains the I/O |
| `files_read` (read verdicts) | **`0`** — bulk read the monitor couldn't attribute to any file, i.e. interpreter/tool startup indexing | a real count, naming files it could attribute |
| New outbound connections at that timestamp | none; same steady-state HTTPS to the Anthropic API | anything new |

All benign → false positive. Unfreeze and carry on:

```bash
coi unfreeze coi-88cded0c-1
```

**Two detectors, don't confuse them.** In `allowlist` mode (the night profile) *any* non-allowlisted
egress fires HIGH, which benign Ubuntu/Canonical background traffic trips — that one is known-noisy
and is why the night profile sets `[monitoring.nft] enabled = false`. The startup freeze above is a
*different* detector, `file_read_rate_mb_per_sec`, which arms in `restricted` mode too, so daytime
sessions get it as well.

**There is a *write* detector too, and it is the one that will actually bite you.** `pnpm install`
freezes the container:

```
Large workspace write detected: Write 127.54 MB at 61.30 MB/sec (threshold: 50.00 MB)   → paused
Large workspace write detected: Write  26.43 MB at 13.21 MB/sec (threshold: 10.00 MB)   → logged (already paused)
```

Five things about this that are not obvious from the log — all read out of COI's source
(`localNotes/code-on-incus`, commit `d304121`) on 2026-09-07:

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

The comment says "Default:", implying an override. **There is none** — no `WithFileWriteThreshold`
setter exists, though `WithProcessCountThreshold` and `WithProcessSpawnRateThreshold` do. The
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

**Sizing — against observed load, not hardware maximums.** Peak here was 61 MB/s / 127 MB per poll,
for a 479 MB `node_modules`. Roughly 4x that:

```toml
[monitoring]
enabled               = true
poll_interval_sec     = 2
auto_pause_on_high    = true
auto_kill_on_critical = true

# These two drive BOTH the read and write detectors (detector.go:26-27 copies them into
# the write fields; there is no file_write_* key). rate is the real knob;
# threshold_mb must equal rate × poll_interval_sec or the lower one silently binds.
file_read_threshold_mb    = 500   # was 50 — burst, MB in one 2s poll
file_read_rate_mb_per_sec = 250   # was 10 — sustained ceiling, MB/s
```

A cold `docker build` may still trip this occasionally. That is the intended tradeoff, and the
process list in the verdict tells you why in one command.

> **A threshold above the container's real write ceiling can never fire — that is
> `enabled = false` with extra steps.** Measured on this rig, 2026-09-07, **inside the container**
> (`/tmp` is the rootfs; `/workspace` is virtiofs to the Mac):
>
> | Target | Path | Speed |
> | --- | --- | --- |
> | container rootfs | `/tmp` (ext4, `/dev/vda1`) | **2.6 GB/s** |
> | virtiofs to the Mac | `/workspace/localNotes` | **1.2 GB/s** |
>
> ```bash
> # keep count under file_read_threshold_mb or the test freezes you — 300 against a 500 bar
> dd if=/dev/zero of=/tmp/wtest bs=1M count=300 conv=fdatasync; rm -f /tmp/wtest
> ```
>
> Both are upper bounds — `conv=fdatasync` flushes the guest's view but the Mac's page cache still
> buffers underneath. Good enough for the question that matters: the ceiling is 5–10x the 250 MB/s
> threshold, so the detector can actually fire. For scale: `pnpm install` runs at **61 MB/s**, far
> under the raw ceiling, because it is network-bound and writes thousands of small files rather
> than a sequential stream.

**Writes to `/workspace` are invisible to this detector — it cannot see the workspace at all.**
Measured 2026-09-07: two 300 MB writes seconds apart, one to `/tmp` (rootfs) and one to
`/workspace/localNotes` (virtiofs). Only **one** 300 MB spike appears in the audit log. Since rootfs
writes provably count — a 2 GB `/tmp` write produced a verdict — the one that vanished is the
virtiofs write. Confirmed with a second 400 MB virtiofs write that also left no trace.

The mechanism fits: the detector reads cgroup v2 `io.stat` `wbytes`, which counts **block-device**
I/O. Writes to `/workspace` cross virtiofs to the host, where the actual block I/O happens on the
Mac. So:

| Written to | Counts toward the threshold? |
| --- | --- |
| `/tmp`, `~`, container rootfs — temp files, Docker layers, `~/.cache` | **yes** |
| `/workspace/**` — the repo, `node_modules`, **and the pnpm store** | **no** |

Two consequences. Editing files, `vite build`, and `node_modules` itself are free — they can never
trip it. And whatever `pnpm install` writes into `/workspace` is invisible too.

> **Corrected 2026-09-07 (same day).** An earlier version of this paragraph blamed the freeze on
> "pnpm's content-addressable store on the rootfs." That was asserted without checking, and it is
> wrong on both halves: `pnpm config get store-dir` resolves to **`/workspace/.pnpm-store/v11`**,
> `dev=45` — virtiofs, i.e. exactly the filesystem that is invisible here. The store is not the
> source and never was.
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

**Confirming a config change reached the daemon.** The thresholds are read when `coi shell` starts
the monitoring daemon, so they only apply to a new container. Verify from the detector's own output
rather than by inspection — trip it deliberately and read the threshold back:

```bash
dd if=/dev/zero of=/tmp/big bs=1M count=2000 conv=fdatasync; rm -f /tmp/big   # will freeze you
grep '"level":"high"' "$A" | tail -1
```

Observed 2026-09-07 after raising 50 → 500:
`"description":"Write 2000.00 MB at 989.50 MB/sec (threshold: 500.00 MB)"` — the verdict echoes
**500**, so the edit landed. Still `50` would mean it hadn't. Note `2000 / 989.50 = 2.02s`, exactly
one `poll_interval_sec`, confirming the delta-per-poll model. Then `coi unfreeze <name>`.

**Keep `auto_pause_on_high = true`.** Turning it off does stop the freezes, but
`internal/monitor/responder.go:121-136` shows it disarms auto-pause for **network** HIGH threats too
— unexpected outbound connections, the ones actually worth freezing on. Raise the thresholds
instead; that is the targeted fix.

**Levers that do not exist** — checked, so nobody re-derives them:

| Idea | Reality |
| --- | --- |
| Set the keys to `0` to disable | `internal/config/merge.go:144-149` treats zero as "not set", so the 50/10 defaults win |
| Exempt `pnpm install` by process or path | No allowlist, no path exemption, no startup grace period on this detector. (The 30s grace in `filewatcher.go:183-185` belongs to the inotify secret-file watcher — different component) |
| Disable just the filesystem detector | `enabled = false` is all-or-nothing (`internal/cli/monitoring.go:34`) — kills process, network, log and file watchers with it. No per-category switch exists |
| An env var or CLI flag | None. The config layer reads only `COI_CONFIG` (a path); `coi monitor` has no threshold flags |
| Validation blocking a big value | The `>10GB` check is a soft health-report warning; `internal/config/validate.go` has no monitoring validation at all |
| `[limits.disk]` read/write | A different mechanism — a cgroup blkio *throttle*, not the detector. Capping writes below 10 MB/s to dodge the alert would make installs take minutes |

> **Why the second verdict said `logged (already paused)`.** `r.paused` is set true at
> `responder.go:191,199` and **never reset**. After `coi unfreeze`, that daemon still believes the
> container is paused, so further HIGH threats are logged rather than acted on — convenient for
> finishing the session, but a fresh `coi shell` starts a fresh responder with `paused = false` and
> will freeze you again on the next big install. Fix the config; don't rely on this.

Full reasoning: [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md).


#### Container *killed* — the CRITICAL path is a different animal

A freeze is the polite failure. `ThreatLevelCritical` doesn't pause — `internal/monitor/responder.go:137-147`
calls `killContainer()`, and unlike HIGH there is **no already-fired latch**, so it happens again
every time the pattern appears.

What triggers it in practice is not an attack. `internal/monitor/process.go:249-290` holds a
**hardcoded** pattern list — no config key edits it:

```
python -c   python3 -c   perl -e   perl -MIO   php -r   ruby -e   ruby -rsocket
bash -i     sh -i        nc -e     ncat -e     socat    EXEC:     /dev/tcp/   /dev/udp/
socket.socket   fsockopen   powershell   System.Net.Sockets
```

There is a second gate meant to cut false positives (`process.go:298-302`), and it is the whole
problem:

```go
isNetworkRelated := strings.Contains(cmdLower, ":") ||
    strings.Contains(cmdLower, "sock") || strings.Contains(cmdLower, "tcp") || ...
if isNetworkRelated || pattern.pattern == "bash -i" || pattern.pattern == "sh -i" {
```

**Any colon anywhere in the command line qualifies.** A dict literal, a Python slice (`v[-5:]`,
`s[11:19]`), a URL, a timestamp. Every realistic JSON one-liner matches. And `bash -i` / `sh -i`
skip the gate entirely — they always fire.

Observed 2026-09-07, three kills, all benign:

```
npm view aws-cdk-lib versions --json | python3 -c "...print(v[-5:])"
gh api repos/aws/aws-cdk/pulls/32369 | python3 -c "...print('merged_at:', ...)"
<a test harness containing `nc -e ...` and `python3 -c` as fixture strings>
```

Note the first one is what `CLAUDE.md`'s own "always check the registry — `npm view <pkg> version`"
rule leads you to write.

**Why it seems intermittent.** Detection samples the process list every `poll_interval_sec` (2s).
Short one-liners often finish between samples; ones blocked on a slow pipe (`gh api …|`,
`npm view …|`) sit there long enough to be caught every time. Getting away with it is timing, not
safety.

**The fix is not `auto_kill_on_critical = false`** — that flag is the sandbox's actual purpose, and
the pattern list is compiled into the binary, so there is nothing to tune. Stop emitting the shape
instead:

| Instead of | Use |
| --- | --- |
| `python3 -c '…'` | `python3 - <<'PY' … PY` — runs as `python3 -`, not on the list |
| any JSON one-liner | `jq`, which is installed and matches nothing |
| `bash -i -c '…'` | run the command directly |

`.claude/hooks/coi-reverse-shell-guard.sh` denies these at `PreToolUse` on Bash. It no-ops outside a
`coi-*` host, and it matches the **literal text anywhere in the command** — so a heredoc that merely
*writes documentation* mentioning these strings is blocked too. That is deliberate: use the
Write/Edit tools for file content. Blocking too much is the right bias when the failure mode is the
container dying.

Full write-up: [COI-INCIDENTS.md → Incident F](COI-INCIDENTS.md).

### 3. I want to debug inside the container, without Claude

A shell in the box, bypassing COI entirely — the right tool when `coi shell` itself is what's
misbehaving:

```bash
# from the VM
incus exec coi-88cded0c-1 -t --user 1000 --cwd /workspace --env HOME=/home/code -- bash
```

Then the usual: `paste -d/ /sys/fs/cgroup/pids.{current,max}` (want `.../2048`),
`ls ~/.claude/projects/-workspace/`, `df -h`, `mount | grep workspace`.

To relaunch Claude this way instead of `bash`, add the token env var — see *Ops notes → Resume*.

### 4. I'm done

```bash
# ── in the container ──
# 1. Ctrl+D (or /exit)  — leaves Claude Code. You are still in a container shell.
# 2. exit               — leaves `coi shell`. THIS is what exports your session.
#    The container stays running; come back later with `coi attach` (see §1).

# ── in the VM ──  ONLY when you actually want the container GONE —
#    a .coi/config.toml change, or reclaiming disk. Not a routine step.
coi shutdown coi-88cded0c-1               # deletes the container. Name REQUIRED (or --all).
                                          # `coi close` is an alias. --force skips the prompt.

# ── on the Mac ──  (only if you're done for the day — frees the VM's RAM/battery)
limactl stop incus
```

**Steps 1 and 2 are the whole routine.** `coi shutdown` is not part of a normal day: it destroys the
container, which forces a `--resume` next time, which **forks the session** and adds another
`(N)` entry to your picker (see §1). Leave the container running and reattach instead.

**Exiting `coi shell` is the save. `coi shutdown` is the delete.** They are two different programs
doing two different jobs, and this doc had it backwards until 2026-09-07:

- The export is in the **`coi shell` teardown** — `internal/cli/phases_shell.go:443-466` builds
  `session.CleanupOptions{SaveSession: true, SessionsDir: …}` and calls `session.Cleanup`, which
  writes `~/.coi/sessions-claude/<id>/`. It runs whenever that `coi shell` process ends.
- **`coi shutdown` exports nothing.** `internal/cli/shutdown.go` is graceful stop → firewall
  cleanup → `mgr.Delete(true)`. Grep it for `SaveSession`, `Cleanup`, `saveSessionData`,
  `SessionsDir`: no hits.

So you get a full snapshot on **every normal exit**, no `coi shutdown` required. Reach for
`coi shutdown` when you actually want the container gone — picking up a `.coi/config.toml` change,
or reclaiming disk.

> **`Ctrl+D` alone does not export.** It leaves Claude Code and drops you into a bash shell still
> inside the container; `coi shell` is still running, so no teardown has fired. This is why an
> earlier snapshot taken *after* `Ctrl+D` but *before* `coi shutdown` held only `metadata.json` —
> and why all 463 files appeared across the shutdown: killing the container ended `coi shell`,
> which ran the teardown. The mechanism was the shell exiting, not the shutdown command.

**Don't run `coi shutdown` while Claude Code is still up.** It turns the export into a race you do
not control: the dying container ends `coi shell`, whose teardown starts saving
("Save session data immediately — no pre-delay", `internal/session/cleanup.go:243`), while
`coi shutdown` proceeds to `Delete`. `cleanup.go` does handle a mid-shutdown race — on an SFTP error
it waits for the container to fully stop and retries via incus direct file access — but **that
fallback still needs the container to exist**, and `Delete` removes it. *(Inference from the code
ordering; not raced empirically. It went our way on 2026-09-07.)* You also lose the in-flight turn,
and your terminal keeps whatever modes the TUI set — the `35;97;27M…` garbage, fixed with `reset`,
never `stty sane`.

**`coi shutdown` deletes a `persistent = true` container too** — documented in `coi shutdown --help`,
not a bug. That is fine: `coi shell --resume` rebuilds it from the export. To keep a persistent
container, just exit normally (you still get the export) or power it off from inside.


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
# in the Lima VM — `coi` does not exist on the Mac or in the container (see *Start here*)
cd ~/Coding/Personal/aperture && coi shell --resume
```

Bypass perms, restricted network, the Vite range mapped out, no runtime cap. `pnpm dev` inside binds
`6173` (not `5173` — see *Ports* below), and the host port is pinned to match, so
`http://localhost:6173` in your Mac browser is the same server.

`--resume` rebuilds a destroyed container from its exported session and is a no-op on a running one,
so make it the habit — bare `coi shell` on a container COI has torn down gives you an empty box.

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

# 2. Leave `coi shell` itself — THIS is what exports the session to
#    ~/.coi/sessions-claude/<id>/, which `coi shell --resume` reads back.
exit

# 3. Only if you want the container GONE (e.g. to pick up a .coi/config.toml change).
#    DELETES it, persistent ones included. Name required, or --all. `coi close` is an alias.
#    Exports nothing itself — run it only after step 2.
coi shutdown coi-88cded0c-1

# 4. Done for the day — frees the RAM/battery the Lima VM holds.
limactl stop incus
```

Step 1 costs nothing and eliminates a whole failure class. Claude Code is a full-screen TUI that
reconfigures **your local terminal**; it only undoes that on a clean exit. Kill it abruptly — by
sleeping the Mac, dropping the connection, or closing the window — and your terminal keeps whatever
modes it set.

**Step 2 is the one that protects your data, and it is the step people don't know exists.** `Ctrl+D`
leaves *Claude Code*; you are still inside the container with `coi shell` running, and nothing has
been exported yet. The `exit` in step 2 ends `coi shell`, and its teardown
(`internal/cli/phases_shell.go:443-466`, `SaveSession: true`) is what writes
`~/.coi/sessions-claude/<id>/`.

**After step 2 the container is still running — come back with `coi attach`, not `coi shell`.**
Persistent containers are kept alive on exit (`internal/session/cleanup.go:305-315` prints "use
'coi attach' to reconnect"), and `coi attach` is `tmux attach` (`internal/cli/attach.go:160`), so
you rejoin the *same* live `claude` process. Nothing resumes, and nothing forks. Using
`coi shell --resume` here instead would mint a new session id and another `(N)` entry in your
picker — see *Start here → 1*.

Step 3 is optional and does **not** export — `internal/cli/shutdown.go` is stop → firewall cleanup →
`Delete`, with no save call in it. Run it to reclaim disk or to pick up a config change. Skipping it
repeatedly is how you accumulate containers holding GBs each (this rig once had four, one at
2.93 GiB).

> **Nothing is exported until `coi shell` exits.** Evidence: a snapshot taken after `Ctrl+D` but
> before `coi shutdown` held only `metadata.json`; all 463 files appeared across the shutdown. The
> original reading of that — "the export fires on `coi shutdown`" — was wrong. `Ctrl+D` only leaves
> Claude Code, so `coi shell` was still running and no teardown had fired; the shutdown then killed
> the container, which ended `coi shell`, which ran the teardown. **The shell exiting is the
> mechanism.** Same observation, correct cause.
>
> Either way there is **no continuous backup**: everything since your last exit lives only inside
> the container. That is why the cadence matters — exit properly at every real break, not just at
> the end of the day.
>
> **The export *is* a restore — settled 2026-09-07, and an earlier version of this doc said the
> opposite.** The teardown writes the complete `~/.claude` tree to
> `~/.coi/sessions-claude/<session-id>/`, and **`coi shell --resume` reads it back into a fresh
> container.** Measured across a real destroy/restore cycle: `incus list` empty, new container at
> `up 0 minutes`, and every transcript back byte-identical (`189,441 → 189,441`,
> `192,343 → 192,343`), plus `history.jsonl` (your `↑` prompt history), `settings.json`,
> `session-env/`, `file-history/` and `.credentials.json`. `claude --resume` offered the sessions
> and opened them with full context.
>
> The old "nothing restores it — COI defect" claim came from a test that defined success as
> `claude --resume` working and never checked whether COI had its own resume; everything downstream
> was built on that. It stayed unfalsified because the workaround built to fix it — a symlink from
> `~/.claude/projects` onto the repo mount — **made COI skip `projects/` at export time**, so the
> restore could never be observed. Deleting the symlink was the entire fix.
>
> **Two things the restore does not carry.** `~/.claude.json` comes back reset
> (`numStartups: 1`, `history: []`) — harmless, since `↑` history lives in `~/.claude/history.jsonl`
> and that does restore. And `projects/-workspace/memory/` restores as a directory but has only ever
> been empty here, so restore of memory *files* is untested. Both in *Deferred / to-do*.
>
> **`persistent = true` does not suppress the export** — verified; both observed exports record the
> flag and are complete.
>
> What it *does* buy is narrower than the name suggests, and the boundary is documented in
> `coi shutdown --help`: **`coi shutdown` deletes a persistent container outright.** Persistence
> only survives the gentler exits — powering off from inside, or exiting `coi shell`. Since
> `--resume` rebuilds a deleted container from its export anyway, reverting to `persistent = false`
> is close to free.
>
> (A container here was also observed **frozen and unfrozen** between 00:28 and 11:19 on
> 2026-09-07, keeping its rootfs and a live transcript across the gap. Alive / deleted is not the
> whole set of states — check `uptime -p` before concluding a container is new.)

> **`coi shutdown` verified on COI 7.4** (2026-09-06) — it exists and its export fires; see the
> caveat above for what it does and doesn't do. The rest of this doc uses `coi kill` / `coi clean`.
> On another COI version, check `coi --help`: the *ritual* (exit TUI → tear down container → stop
> VM) is what matters, not the spelling.

## One-time setup

**Fresh Mac → working `coi shell`, in order.** Every step here fixed a real failure; none are
optional. Steps 1–2 are on the Mac, 3–11 inside the Lima VM (`limactl shell incus`); step 12 is
retained only as a do-not-do note. Budget ~20 minutes, most of it `coi build`.

This is also the **rebuild procedure** — it was reconstructed the hard way after a `limactl edit`
typo wiped the VM ([COI-INCIDENTS.md → Incident D](COI-INCIDENTS.md)). Before that, this section
jumped from "Incus required" straight to `coi shell` and could not actually get you there.

### On the Mac

1. **Scope the Lima mount to the repo, writable.** Lima mounts the Mac home **read-only**
   (`virtiofs ro`) by default, so the container workspace is read-only — and if `location` is left
   at `~`, the container sees your **entire home directory**, `.ssh` and `.aws` included. Fix both
   with `limactl edit incus`:

   ```yaml
   mounts:
   - location: "~/Coding/Personal/aperture"
     writable: true
   ```

   > **Get the indentation right.** `writable` belongs *under* `location`, no dash. A stray `-`
   > makes it `mounts[1]` — a second entry with no path — and Lima rejects the buffer with
   > `field 'mounts[1].location' must be an absolute path, got '.'`. Recovering from that rejection
   > is what destroyed this VM once already. Mount changes also restart the VM (Incident B.1), so
   > make them **before** starting a long run, never during one.

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
   incus version        # pin what you got here — this rig has run 7.3 and 7.4
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

   | Prompt | Answer | Why |
   | --- | --- | --- |
   | Clustering? | no | single-node |
   | New storage pool? | yes → `default` | required |
   | Backend | `dir` | `zfs` triggers a DKMS kernel-module compile on first use — multi-minute and CPU-bound. `dir` is near-instant. Tradeoff: `dir` re-unpacks the image every launch and forgoes `coi snapshot`; `coi health` will warn about it forever. Revisit deliberately, not mid-rebuild. |
   | Location | default | |
   | New bridge? | yes → `incusbr0` | |
   | IPv4 | `10.66.66.1/24` — **explicit** | see below |
   | NAT IPv4 | yes | |
   | IPv6 | none | not needed |
   | Available over network? | no | |
   | Auto-update images? | yes | |
   | Print YAML preseed? | **yes** | save it — `incus admin init --preseed < file.yaml` turns this whole table into one command next time. (Skipped during the real rebuild; still an open follow-up.) |

   > **Don't bother with `--auto`.** It fails at subnet detection —
   > `Failed to automatically find an unused IPv4 subnet, manual configuration required` — even
   > when `ip addr`/`ip route` show only Lima's own `192.168.5.0/24` in use. Never diagnosed.
   > Specifying the subnet explicitly works; don't burn time here.

6. **Delegate host UID 501 to Incus.** Launch otherwise fails *"UID namespace isolation not
   supported"*. Confirmed entirely absent on a fresh VM:

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
   curl -fsSL https://raw.githubusercontent.com/mensfeld/code-on-incus/master/install.sh | bash
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

   *36 checks passed with 2 warnings* is the known-good end state for this rig.

10. **Make COI's own state durable (VM half) — don't skip this one.** `~` in the Lima VM is
    `/home/<user>.guest`, which is **VM-local**. The Mac is reachable only at `/Users/<you>/…`, and
    only through `mounts:`. So `~/.coi/` is *not* on the Mac, and a VM rebuild takes everything in
    it: your `coi` profiles, and every Claude Code session `coi shutdown` exported to
    `~/.coi/sessions-claude/<id>/`. That has already cost two session transcripts and the
    `aperture-night` profile.

    ```bash
    /Users/<you>/Coding/Personal/aperture/scripts/coi-vm-setup.sh
    ```

    Symlinks `~/.coi/sessions-claude` and `~/.coi/profiles` into `localNotes/coi-state/` on the repo
    mount. Idempotent, migrates existing content rather than replacing it, refuses rather than
    clobbering anything unexpected. **Deliberately not a `lima.yaml` edit** — mount changes restart
    the VM, and a typo in one is what caused the rebuild in the first place.

    Verify any time with `scripts/coi-vm-setup.sh --check` (exit 1 if the links are gone). Worth
    running once after a `coi shutdown` cycle: it is not yet confirmed whether `coi` recreates those
    paths with `mkdir -p` (a symlink survives) or replaces them outright (it does not).

    **This is the step that matters most, and it protects the mechanism you actually depend on.**
    `coi shell --resume` restores a destroyed container from `~/.coi/sessions-claude/`, and that
    directory is VM-local — a VM rebuild deletes COI's entire saved-session store outright. That is
    exactly what made sessions `94ef8ba6` and `12279d4a` unrecoverable
    ([Incident D](COI-INCIDENTS.md)). This step mirrors it onto Mac disk, so COI's own restore
    survives a rebuild.

    It only covers what `coi shutdown` exports. Nothing is written between shutdowns — see
    *Run → Ending a session*.

11. **First shell, trust, and verify the scoping.**

    ```bash
    cd ~/Coding/Personal/aperture && coi shell
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
    paste -d/ /sys/fs/cgroup/pids.{current,max}   # want .../2048 — see Incident A
    ```

12. **~~Make the transcript durable (container half).~~ Removed 2026-09-07 — do not do this.**

    This step ran `scripts/coi-container-setup.sh`, which symlinked `~/.claude/projects` onto the
    repo mount so Claude Code appended the transcript straight to Mac disk. The script has been
    deleted.

    It was built to cover "nothing is exported unless `coi` runs its graceful teardown" — but it
    **caused** the problem it was believed to be solving. COI does not follow that symlink at export
    time, so with it installed `coi shell --resume` came back without your transcripts, and the
    restore that does work could never be observed. Removing it was the whole fix; see
    *Run → Ending a session* for the measurements.

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
| `.coi/config.toml`                           | **repo (committed)** | Daytime posture: `coi-default` image, `permission_mode=bypass`, CPU/mem caps, `network.mode=restricted`, the Vite `6173–6183` port map (`host` pinned == `container`), monitoring on. Secret-free. |
| `~/.coi/config.toml`                         | user (trusted)             | Auth injection: `[defaults.env_commands]` `CLAUDE_CODE_OAUTH_TOKEN = "cat $HOME/.coi-claude-token"`.                                                                                                        |
| `~/.coi-claude-token`                        | user, mode 600             | The token itself. Never mounted into the workspace.                                                                                                                                                            |
| `~/.coi/profiles/aperture-night/config.toml` | user (trusted)             | Night deltas: `network.mode=allowlist` + `allowed_domains`, `limits.runtime.max_duration="10h"`, `auto_stop=true`, `[monitoring.nft] enabled=false`.                                                  |

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

| Symptom                                                                                                             | Cause                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt fills with`35;97;27M…` garbage                                                                            | A killed TUI never restored your terminal's mouse-reporting mode                                                                                     | Exit Claude cleanly (`Ctrl+D`). To recover: accept iTerm's "turn it off" prompt, or `reset`. **`stty sane` does not work.**                                                                                                                                                                                                                                                          |
| Long unattended run died ~when you shut the laptop                                                                  | `'Clamshell Sleep'` — lid close forces sleep; **`caffeinate` does not prevent it** (and on battery it does nothing at all)                | Lid open + AC +`caffeinate -s`; or clamshell mode / Amphetamine closed-display. Always on AC.                                                                                                                                                                                                                                                                                                  |
| `Session can't start — SIGABRT (134)` on a 2nd/3rd session                                                       | Container **pids cgroup** ceiling saturated (`limits.processes`), `clone()` → `EAGAIN`. **Not** memory, **not** a Claude bug | `paste -d/ /sys/fs/cgroup/pids.{current,max}` — if close, raise `max_processes` in `.coi/config.toml` (now `2048`, verified landing). Hot-patch: `incus config set <ctr> limits.processes 8192` on the **host**. **Always verify a fresh container reports the number you wrote** — `1024` silently didn't take, `2048` did, and the difference was never explained. |
| Every container loses its mounts at once, then the VM reboots                                                       | A host-mount config change: the path must be visible in the Lima VM first, so applying it restarts the VM and kills every session                    | Make mount changes **before** starting a long run                                                                                                                                                                                                                                                                                                                                           |
| `vite dev`/`build`: `Cannot find module '../lightningcss.*.node'` (or a `@tailwindcss/oxide` binding error) | `node_modules` is shared with the macOS host; native binaries belong to whoever installed last                                                     | `pnpm install` on the side you're using (`CI=true` inside the container). Doesn't affect `tsc`/`vitest`.                                                                                                                                                                                                                                                                                 |
| Container `Frozen`, "PAUSED due to security threat" — on session start, or the moment you run `pnpm install`                                     | Two detectors, one pair of keys. On startup: read I/O. On `pnpm install`: writes — and the write detector borrows `file_read_*` (`detector.go:26-27`), so 50 MB / 10 MB/s applies to a 127 MB, 61 MB/s install. Measures whole-container cgroup I/O, not just the workspace. Both false positives                              | `coi unfreeze <name>`. Full triage procedure: *Start here → 2 → Container frozen — find out what tripped it*. Investigate via the raw file, never `coi audit <name>` (read-path defect). Reasoning: [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md)                                                                                                                                                         |
| `coi audit <name>` prints nothing for a container you can see in `coi list`                                         | CLI read-path defect — the on-disk history exists and is complete                                                                                                                                          | Read `~/.coi/audit/<name>.jsonl` directly — see *Start here → 2 → Container frozen*. `coi audit -f` is for live monitoring only.                                                                                                                                                                                                                                                        |
| Session lost after a crash / reboot / lid-close, with no `coi shutdown`                                             | The export only fires on graceful `coi` teardown — an ungraceful death exports nothing, so everything since the last shutdown is gone with the container                                                    | No fix, by design — there is no continuous backup. Exit `coi shell` at every real break (that teardown is the export) and reattach with `coi attach`; do **not** reach for `coi shutdown`, which exports nothing and forks the session. If it ever bites for real, relocate all of `~/.claude` to Mac disk with `CLAUDE_CONFIG_DIR` (*Deferred*) — **not** a `projects` symlink, which breaks the restore |
| Previous session gone; `--resume` doesn't offer it                                                                  | You ran bare `coi shell`, or the container had a `~/.claude/projects` symlink (removed 2026-09-07 — see *One-time setup* step 12), which COI skips at export. Or `~/.coi/` was lost to a VM rebuild, since it is VM-local                                                       | `ls -ld ~/.claude/projects` — an arrow into `/workspace` is the symlink; remove it per step 12. Otherwise `coi shell --resume`. Recover by hand from `localNotes/coi-state/sessions-claude/<id>/.claude/projects/` or `.../container/projects/`. Prevent the rebuild case with *One-time setup* step 10 (`scripts/coi-vm-setup.sh`).                                                                                                                                                                                                                                             |
| `coi` profiles or `~/.coi` config vanished                                                                          | Same cause: `~/.coi/` lives on the VM disk, not the Mac                                                                                                                                                    | *One-time setup* step 10 (`scripts/coi-vm-setup.sh`). Recreate the profile once, then it persists.                                                                                                                                                                                                                                                                                                                        |
| Four "ephemeral" containers alive, GBs each                                                                         | Ephemeral destroy +`--resume` write happen only on a graceful shutdown                                                                             | Tear down properly when done — see*Run → Ending a session*                                                                                                                                                                                                                                                                                                                                   |

## Ops notes

- **Resume.** An ephemeral container left Running (Claude exited without a clean teardown) does **not**
  produce a session for `claude --resume` (the Claude Code flag — not `coi shell --resume`, which is
  about the container) — that's saved only on graceful `coi shutdown`. The transcript lives at
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
- **`coi audit`'s read path.** ~~There is no on-disk history~~ — **corrected 2026-09-06.** There
  is: `~/.coi/audit/<container>.jsonl` holds per-poll JSON Lines telemetry (connections, processes,
  filesystem rates, resource usage, and every threat verdict) for the container's whole lifetime,
  complete and legible. What's broken is retrieval — `coi audit <name>` returned empty output for a
  container whose file was fully populated. So the question *"did the monitor pause or kill this
  run?"* **is** answerable; just `cat`/`grep` the file. Worth filing upstream as a CLI defect, not
  as a missing feature. See [COI-INCIDENTS.md → Incident E](COI-INCIDENTS.md).

- **Session-restore leftovers (2026-09-07).** `coi shell --resume` restores `~/.claude` completely
  (*Run → Ending a session*). Three loose ends, none blocking:

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
  Nothing is exported between `coi shutdown` calls, so a VM rebuild or storage loss without one
  still costs you the window. The fix is *not* a `projects` symlink (that breaks the restore — see
  *One-time setup* step 12); it's relocating all of `~/.claude` onto Mac disk:

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
