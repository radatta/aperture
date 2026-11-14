# tools/macstats

The Mac stats agent for the web tower: a launchd job that writes the Mac's memory, load and VM size to
`localNotes/board/mac-stats.json` every 15 s. Install, trust boundary and output: `docs/ops/TOWER.md` → _Mac stats_.

- `macstats.sh`: one tick (`--render <dir>` is the test seam, fed `scripts/src/board/tower/fixtures/mac/`).
- `install.sh`: install from GitHub at main's head (or `--ref <sha>`), `--uninstall`.
- `dev.rahuldatta.aperture.macstats.plist.tmpl`: the LaunchAgent, rendered by the installer.
