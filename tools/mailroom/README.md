# Mac mailroom

A launchd agent on the Mac. It runs allowlisted jobs that Claude drops into `.hostjobs/inbox/`. Today the only job opens a PR as the user, using their PR-only token. Design, token, security and trial: [docs/ops/MAILROOM.md](../../docs/ops/MAILROOM.md).

- `runner.sh` + `jobs/*.sh`: the clerk. launchd runs the **installed copy**, fetched from GitHub at merged `main`, never these files.
- `install.sh`: install or update (`--mode queue|poll`, `--ref <sha>`), or `--uninstall`. Run it fetched from `main`; the one-liner is in MAILROOM.md → _Install_.
- `dev.rahuldatta.aperture.mailroom.plist.tmpl`: the LaunchAgent that `install.sh` renders.
- `run-fixtures.sh` + `testdata/jobs.jsonl`: the runner's fixture suite. It also runs inside `pnpm test`.
