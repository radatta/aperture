# Mac mailroom

A launchd agent on the Mac. It runs allowlisted jobs that Claude drops into `.hostjobs/inbox/`: `open-pr` opens a PR as the user with their PR-only token; `sim` drives the iOS Simulator for the devcheck's iOS rows; `clip` hands the container the clipboard's image for a Ctrl+V (MAILROOM.md → _The clip job_; container side: `tools/coi/xclip`). Design, token, security and trial: [docs/ops/MAILROOM.md](../../docs/ops/MAILROOM.md); the sim job: [docs/ops/IOS-CHECK.md](../../docs/ops/IOS-CHECK.md).

- `runner.sh` + `jobs/*.sh`: the clerk. launchd runs the **installed copy**, fetched from GitHub at merged `main`, never these files.
- `install.sh`: install or update (`--mode queue|poll`, `--ref <sha>`), or `--uninstall`. Run it fetched from `main`; the one-liner is in MAILROOM.md → _Install_.
- `dev.rahuldatta.aperture.mailroom.plist.tmpl`: the LaunchAgent that `install.sh` renders twice, once per lane (`…mailroom` slow, `…mailroom.fast` fast; the lane is the runner's third argument).
- `run-fixtures.sh` + `testdata/jobs.jsonl`: the runner's fixture suite. It also runs inside `pnpm test`.
- `bench/`: the sim bench. It replays the devcheck's iOS jobs N× through `runner.sh` + `jobs/sim.sh` on any Mac and times them ([docs/ops/SIM-BENCH.md](../../docs/ops/SIM-BENCH.md)).
