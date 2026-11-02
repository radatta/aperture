# Mac mailroom

A launchd agent on the Mac. It runs allowlisted jobs that Claude drops into `.hostjobs/inbox/`. Today the one job is opening a PR as the user, with their PR-only token. Design, token, security and trial: [docs/ops/MAILROOM.md](../../docs/ops/MAILROOM.md).

- `runner.sh` + `jobs/*.sh` — the clerk. launchd runs the **installed copy**, never these files.
- `install.sh` — install or update (`--mode queue|poll`), or `--uninstall`. Prints the diff it installs.
- `dev.rahuldatta.aperture.mailroom.plist.tmpl` — the LaunchAgent that `install.sh` renders.
- `run-fixtures.sh` + `testdata/jobs.jsonl` — the runner's fixture suite. It also runs inside `pnpm test`.

```sh
cd /Users/rahuldatta/Coding/Personal/aperture && bash tools/mailroom/install.sh
```
