# tools/macstats

The Mac stats agent for the web tower: a launchd job that writes the Mac's memory, load, VM size and power (battery,
Low Power Mode, thermal limits, from `pmset -g`) to
`localNotes/board/mac-stats.json` every 15 s. Install, trust boundary and output: `docs/ops/TOWER.md` → _Mac stats_.

- `macstats.sh`: one tick (`--render <dir>` is the test seam, fed `scripts/src/board/tower/fixtures/mac/`:
  `vm_stat.txt`, `sysctl.txt`, `ps.txt`, and the optional `pmset-batt.txt`, `pmset.txt`, `pmset-therm.txt`).
- `install.sh`: install from GitHub at main's head (or `--ref <sha>`), `--uninstall`.
- `dev.rahuldatta.aperture.macstats.plist.tmpl`: the LaunchAgent, rendered by the installer.
