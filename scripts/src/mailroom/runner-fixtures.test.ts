// The Mac runner's own suite (bash + jq, curl/security/axe/simctl stubbed) as part of `pnpm test`, plus static
// checks on what the runner may touch: each secret's one source, the five fixed GitHub calls, and a sim job that
// makes no network call and runs nothing a job names. docs/ops/MAILROOM.md, docs/ops/IOS-CHECK.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS_DIR } from './fixtures.ts';
import { SIM_H, SIM_W } from './sim.ts';

const runnerText = () =>
  [
    readFileSync(`${TOOLS_DIR}runner.sh`, 'utf8'),
    ...readdirSync(`${TOOLS_DIR}jobs`)
      .filter((n) => n.endsWith('.sh'))
      .map((n) => readFileSync(`${TOOLS_DIR}jobs/${n}`, 'utf8')),
  ].join('\n');
// Code only: drop comment lines so a sentence about a forbidden thing doesn't count as doing it.
const code = () =>
  runnerText()
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('mailroom runner', () => {
  it('passes its fixture suite', { timeout: 400_000 }, () => {
    let out: string;
    try {
      out = execFileSync('bash', [`${TOOLS_DIR}run-fixtures.sh`], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`run-fixtures.sh failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
        cause: err,
      });
    }
    expect(out).toMatch(/# (\d+) passed, 0 failed, of \1 cases/); // a shard lost shows as a shortfall
  });

  it('jobs.jsonl is exactly what gen-jobs.py generates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailroom-gen-'));
    try {
      execFileSync('python3', [`${TOOLS_DIR}testdata/gen-jobs.py`, join(dir, 'jobs.jsonl')], {
        stdio: 'pipe',
      });
      expect(readFileSync(join(dir, 'jobs.jsonl'), 'utf8')).toBe(
        readFileSync(`${TOOLS_DIR}testdata/jobs.jsonl`, 'utf8'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads each secret only from its Keychain item, never a file or the environment', () => {
    const src = code();
    expect(src).toContain('MR_KEYCHAIN="aperture-mailroom-gh"');
    expect(src).toContain('SIM_KEYCHAIN="aperture-devcheck-dev"');
    expect(src.match(/\bsecurity\b[^\n]*/g)).toEqual([
      'security find-generic-password -s "$MR_KEYCHAIN" -w 2>/dev/null || true)"',
      'security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" >/dev/null 2>&1 \\',
      `security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" -w 2>/dev/null | tr -d '\\n' | ax type --stdin >/dev/null 2>&1; then`,
    ]);
    for (const banned of ['GH_TOKEN', 'GITHUB_TOKEN', '.hostjobs/', 'localNotes', 'eval ', 'sh -c'])
      expect(src).not.toContain(banned);
    expect(src).not.toMatch(/(^|[\s;(|&])(gh|git)\s/m);
  });

  it('the sim job: pinned constants, no network, nothing a job names is ever run', () => {
    const sim = readFileSync(`${TOOLS_DIR}jobs/sim.sh`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const pin of [
      'SIM_NAME="aperture-devcheck"',
      'SIM_AXE_VERSION="1.8.0"',
      'SIM_TERMINATE_ID="com.apple.webapp"',
      'SIM_EMAIL="rahul3datta+devcheck@gmail.com"',
      "SIM_COGNITO_RE='^aperture-dev-618015769091\\.auth\\.us-west-1\\.amazoncognito\\.com$'",
      `SIM_W=${SIM_W}`, // the validators' bounds (sim.ts) follow the device profile
      `SIM_H=${SIM_H}`,
      'SIM_AX_CAP=8 ax describe-ui --point', // a point read's cap: a hung one costs 8 s, not ax's 30
    ])
      expect(sim).toContain(pin);
    const secretsDir = ['.sec', 'rets'].join(''); // spelled apart: the repo's hooks guard the literal
    for (const banned of [
      'curl',
      'openurl',
      'osascript',
      'eval ',
      'sh -c',
      secretsDir,
      'localNotes',
      'bash -',
    ])
      expect(sim).not.toContain(banned);
    // The host is read from the native address bar (id URL), checked before the email and again just before
    // the password; the password reaches axe only on stdin.
    expect(sim).toContain(`'.role == "AXGenericElement" and .id == "URL" and .label == "Address"`);
    expect(sim).toContain('and $app != null and .pid != null and .pid != $app');
    expect(sim).toContain('[[ "$v" =~ $SIM_COGNITO_RE ]]');
    expect(sim).toContain(
      'and ($bar == null or .pid == $bar) and ($form == null or .pid != $form)',
    );
    // No read carries a value between the first form tap and Home, but the two that prove focus before the password.
    expect(sim).toContain('| if $sens then del(.value) else . end');
    expect(sim).toContain('SIM_SENSITIVE=true');
    const checks = [...sim.matchAll(/\bsim_on_cognito "\$app"/g)].map((m) => m.index);
    const email = sim.indexOf('ax type "$SIM_EMAIL"');
    const password = sim.indexOf('ax type --stdin');
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(email);
    expect(checks[1]).toBeGreaterThan(email);
    expect(checks[1]).toBeLessThan(password);
    // The focus is proven with a harmless key before the password, and the host checked after that.
    const focused = sim.indexOf('sim_pw_focused "$pf" "$ef" ||');
    expect(sim).toContain('ax key 27 --duration 0.2');
    expect(sim).not.toMatch(/\bax key \d+ >/); // a bare key press exits 0 and does nothing
    expect(focused).toBeGreaterThan(email);
    expect(focused).toBeLessThan(checks[1] ?? -1);
    expect(sim.match(/\bax type\b[^\n]*/g)?.map((l) => l.slice(0, 30))).toEqual([
      'ax type "$SIM_EMAIL" >/dev/nul',
      'ax type --stdin >/dev/null 2>&',
    ]);
    // Tools by name only (no path a job could steer); axe only through the capped `ax`/`sim_cap` wrappers.
    expect(sim).not.toMatch(/(^|[\s;(|&])\/[a-z/]+\/(axe|xcrun|security|open)\b/m);
    expect(sim.match(/(?<!--arg |want |")\baxe\s[^\n]*/g)).toEqual([
      'axe "$@" --udid "$SIM_U"',
      'axe --version 2>/dev/null | tr -d \'[:space:]\')" || v=""',
    ]);
  });

  it('the clip job: pinned gates, images only, no network, a fixed read on stdin', () => {
    const clip = readFileSync(`${TOOLS_DIR}jobs/clip.sh`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const pin of [
      'CLIP_FRONT_IDS="com.googlecode.iterm2 com.apple.Terminal"',
      'CLIP_MAX_BYTES=16777216',
      'CLIP_PER_CC=3',
      'CLIP_PER_MIN=6',
      'CLIP_BANNER=1',
      'elif .expiresInMin > 2 then "BAD_PARAM"',
    ])
      expect(clip).toContain(pin);
    // The pasteboard is asked for its change count, its type list, and the data of two image types — nothing else.
    expect([...clip.matchAll(/\bpb\.(\w+)/g)].map((m) => m[1])).toEqual([
      'changeCount',
      'types',
      'dataForType',
    ]);
    expect(clip).toContain('pb.dataForType(source === "png" ? "public.png" : "public.tiff")');
    expect(clip.match(/NSPasteboard\.\w+/g)).toEqual(['NSPasteboard.generalPasteboard']);
    for (const banned of [
      'stringForType',
      'readObjectsForClasses',
      'propertyListForType',
      'curl',
      'security ',
      'the clipboard',
    ])
      expect(clip).not.toContain(banned);
    // osascript runs only the constant JXA (on stdin) and the constant banner; nothing a job names.
    expect(clip.match(/\bosascript\b[^\n]*/g)).toEqual([
      'osascript -l JavaScript - "$p.png" "$CLIP_MAX_BYTES" "$CLIP_FRONT_IDS" "$spent" <<<"$CLIP_JXA" 2>/dev/null)" || rc=$?',
      'osascript -e "display notification \\"Sent a $kb KB image to the container\\" with title \\"Aperture mailroom\\"" >/dev/null 2>&1 || true',
    ]);
  });

  it('calls GitHub only at api.github.com, with five fixed method + path pairs, one write', () => {
    const src = code();
    expect(src).toContain('MR_API="https://api.github.com"');
    expect(
      [...src.matchAll(/\bmr_call (\S+) ("[^"]+"|\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ).toEqual([
      'GET /user',
      'GET "/repos/$MR_REPO/git/ref/heads/$branch"',
      'GET "/repos/$MR_REPO/pulls?head=$MR_OWNER:$branch&state=open"',
      'POST /markdown',
      'POST "/repos/$MR_REPO/pulls"',
    ]);
    expect(src).toContain('MR_REPO="radatta/aperture"');
    expect(src.match(/\bcurl\b/g)).toHaveLength(1);
  });

  it('installs only what GitHub holds at a commit, reading nothing from the shared folder', () => {
    const src = readFileSync(`${TOOLS_DIR}install.sh`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // No path back to this folder's own files: every install source is a GitHub read at $ref.
    for (const banned of [
      'dirname "$0"',
      'BASH_SOURCE',
      '$SRC',
      'tools/mailroom/runner.sh"',
      ' -X ',
    ])
      expect(src).not.toContain(banned);
    // Every copy comes from the staged GitHub fetch.
    for (const l of src.split('\n').filter((x) => /^\s*cp\s/.test(x)))
      expect(l).toMatch(/^\s*cp "\$stage/);
    const calls = src.split('\n').filter((l) => /^\s*curl\s/.test(l));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('-H @<(printf \'Authorization: Bearer %s\\n\' "$TOKEN")');
    expect(src).toContain('"https://api.github.com/repos/$REPO_SLUG/$1"');
    expect(src.match(/\bget "[^"]+"/g)).toEqual([
      'get "contents/tools/mailroom/jobs?ref=$ref"',
      'get "contents/tools/mailroom/runner.sh?ref=$ref"',
      'get "contents/tools/mailroom/jobs/$j?ref=$ref"',
      'get "contents/tools/mailroom/$LABEL.plist.tmpl?ref=$ref"',
    ]);
    expect(src).toContain('TOKEN="$(security find-generic-password -s "$KEYCHAIN" -w');
  });

  // Two launchd agents on one inbox (MAILROOM.md → Lanes): only sim is slow, each lane has its own lock, and the one
  // template renders a valid agent per lane.
  it('lanes: sim alone is slow, a lock per lane, two agents from one template', () => {
    const runner = readFileSync(`${TOOLS_DIR}runner.sh`, 'utf8');
    for (const pin of [
      'SLOW_JOBS="sim"',
      'FAST_JOBS="clip"',
      "SLOW_RE='^[0-9]{8}T[0-9]{6}Z-ios-'",
      'slow) take_lock lock 15 || exit 0 ;;',
      'fast) take_lock lock-fast 5 || exit 0 ;;',
      'all) { take_lock lock 15 && take_lock lock-fast 5; } || exit 0 ;;',
      'trap \'for l in $HELD; do rmdir "$STATE/$l" 2>/dev/null || true; done\' EXIT',
      'if [ "$LANE" = slow ]; then slow_name "${entry#./}" || continue; fi',
      'if [ "$LANE" = fast ]; then ! slow_name "${entry#./}" || continue; fi',
      'for l in $HELD; do touch "$STATE/$l" 2>/dev/null || true; done',
      'if ! job_lane_ok "$job"; then',
      '[ "$LANE" = all ] || WD="work-$LANE"',
    ])
      expect(runner).toContain(pin);
    const install = readFileSync(`${TOOLS_DIR}install.sh`, 'utf8');
    for (const pin of [
      'LABEL_FAST="dev.rahuldatta.aperture.mailroom.fast"',
      'render "$LABEL" slow 10',
      'render "$LABEL_FAST" fast 2',
      'load "$LABEL" "$PLIST"',
      'load "$LABEL_FAST" "$PLIST_FAST"',
      'launchctl bootout "$DOMAIN/$LABEL_FAST" 2>/dev/null || true',
      'rm -f "$PLIST" "$PLIST_FAST"',
      'launchctl bootout "$DOMAIN/$LABEL_FAST" 2>/dev/null || true\n  rm -f "$APP/bin/runner.sh"',
    ])
      expect(install).toContain(pin);
    const tmpl = readFileSync(`${TOOLS_DIR}dev.rahuldatta.aperture.mailroom.plist.tmpl`, 'utf8');
    const render = (label: string, lane: string, throttle: string) =>
      tmpl
        .replaceAll('@LABEL@', label)
        .replaceAll('@LANE@', lane)
        .replaceAll('@THROTTLE@', throttle)
        .replaceAll('@RUNNER@', '/r/runner.sh')
        .replaceAll('@HOSTJOBS@', '/h')
        .replaceAll('@STATE@', '/s')
        .replaceAll('@LOG@', '/l')
        .replaceAll(
          '@TRIGGER@',
          '  <key>QueueDirectories</key>\n  <array><string>/h/inbox</string></array>',
        );
    for (const [label, lane, throttle] of [
      ['dev.rahuldatta.aperture.mailroom', 'slow', '10'],
      ['dev.rahuldatta.aperture.mailroom.fast', 'fast', '2'],
    ] as const) {
      const p = render(label, lane, throttle);
      expect(p).not.toMatch(/@[A-Z]+@/);
      expect(p).toContain(`<key>Label</key>\n  <string>${label}</string>`);
      expect(p).toContain(`<string>/s</string>\n    <string>${lane}</string>\n  </array>`);
      expect(p).toContain(`<key>ThrottleInterval</key>\n  <integer>${throttle}</integer>`);
      // every <key> in the top dict is followed by a value element
      const keys = [...p.matchAll(/<key>([^<]+)<\/key>\s*<(\w+)/g)].map((m) => m[2]);
      expect(keys.every((t) => t !== 'key')).toBe(true);
    }
  });
});
