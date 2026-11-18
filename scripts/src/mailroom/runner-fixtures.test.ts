// The Mac runner's own suite (bash + jq, curl/security/axe/simctl stubbed) as part of `pnpm test`, plus static
// checks on what the runner may touch: each secret's one source, the five fixed GitHub calls, and a sim job that
// makes no network call and runs nothing a job names. docs/ops/MAILROOM.md, docs/ops/IOS-CHECK.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDS, simCognitoPin } from '../identifiers.ts';
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

  // The Mac runs these under bash 3.2, which brace-expands a {a,b} or {a..b} inside a double-quoted $( ) once a nested
  // " appears in it (the MIXED_TEXT result came out as no JSON, 2026-11-13); this suite runs bash 5, so the shape is
  // pinned out instead. A bare v="$(…)" is safe (no brace expansion in assignments); `local v="$(…)"` is not.
  // One line at a time: a multi-line $( ) is out of its reach.
  it('no brace pattern inside a quoted $( ) with a nested quote (bash 3.2 expands it)', () => {
    const src = [
      runnerText(),
      readFileSync(`${TOOLS_DIR}install.sh`, 'utf8'),
      readFileSync(`${TOOLS_DIR}run-fixtures.sh`, 'utf8'),
    ].join('\n');
    const re = /"[^"]*\$\([^"]*"(?:[^"]*"[^"]*")*[^"]*\{[^{}\s"]*(,|\.\.)[^{}"]*\}/; // an odd count of " before it
    const bad = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && re.test(l) && !/^\s*[A-Za-z_]\w*="\$\(/.test(l));
    expect(bad).toEqual([]);
  });

  it('reads each secret only from its Keychain item, never a file or the environment', () => {
    const src = code();
    expect(src).toContain('MR_KEYCHAIN="aperture-mailroom-gh"');
    expect(src).toContain('SIM_KEYCHAIN="aperture-devcheck-dev"');
    // The fixtures job's sandbox profile names the Keychain only to deny it (jobs/fixtures.sh → fx_profile).
    expect(src.match(/\bsecurity\b[^\n]*/g)).toEqual([
      'security.agent"))\' \\',
      'security") (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/pbpaste") (literal "/usr/bin/pbcopy") (literal "/usr/bin/xcrun") (literal "/usr/bin/defaults"))\'',
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
      'SIM_AXE_VERSIONS="1.8.0 2.0.4"', // each exact (IOS-CHECK.md → Setup)
      'SIM_TERMINATE_ID="com.apple.webapp"',
      `SIM_EMAIL="${IDS.email.devTestUser}"`,
      simCognitoPin(), // the one line the dev account id may stay a literal (tracked-identifiers.test.ts)
      `SIM_W=${SIM_W}`, // the validators' bounds (sim.ts) follow the device profile
      `SIM_H=${SIM_H}`,
      'SIM_AX_CAP=8 ax describe-ui --point', // a point read's cap: a hung one costs 8 s, not ax's 30
      // F91: every lock the drain holds is touched (a hand run holds lock-fast too), never just the slow lane's
      'sim_touch() { for l in ${HELD:-lock}; do touch "${STATE:-.}/$l" 2>/dev/null || true; done; }',
      // The switcher kill's ladder and polls (IOS-CHECK.md → Switcher kill); the double home's argv is what F209's CI-side
      // AXe routing keys on (two `button home` steps in one batch), so it stays byte for byte.
      '1) echo "flick 70 0.3 - - -" ;;',
      '2) echo "lead 70 0.3 - 1 0.5" ;;',
      '3) echo "drag 88 0.6 20 1 0.5" ;;',
      'SIM_KILL_POLLS=6',
      'ax batch --step "button home" --step "sleep 0.15" --step "button home" --step "sleep 1.5"',
    ])
      expect(sim).toContain(pin);
    expect(sim).not.toMatch(/touch "\$\{?STATE(:-\.)?\}?\/lock"/);
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
      'axe --version 2>/dev/null)" || v=""', // read whole, then its number alone (the 2.0.4 pin)
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
      'CLIP_BANNER=0', // no notification per serve (MAILROOM.md → The clip job)
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

  // open-pr.sh holds the start both PR jobs share (mr_begin: the token, GET /user, the branch ref) and the render
  // check (mr_render); each job adds its own lookup and its one write, after the render.
  it('calls GitHub only at api.github.com: five fixed method + path pairs per PR job, one write each', () => {
    const src = code();
    expect(src).toContain('MR_API="https://api.github.com"');
    const job = (n: string) =>
      readFileSync(`${TOOLS_DIR}jobs/${n}`, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    const calls = (t: string) =>
      [...t.matchAll(/\bmr_call (\S+) ("[^"]+"|\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
    const LIST = 'GET "/repos/$MR_REPO/pulls?head=$MR_OWNER:$MR_BRANCH&state=open"';
    const open = job('open-pr.sh');
    const edit = job('edit-pr.sh');
    expect(calls(open)).toEqual([
      'GET /user',
      'GET "/repos/$MR_REPO/git/ref/heads/$MR_BRANCH"',
      'POST /markdown',
      LIST,
      'POST "/repos/$MR_REPO/pulls"',
    ]);
    expect(calls(edit)).toEqual([LIST, 'PATCH "/repos/$MR_REPO/pulls/$n"']);
    // fixtures reads only: the compare (the install check) and the tarball, after mr_whoami.
    expect(calls(job('fixtures.sh'))).toEqual([
      'GET "/repos/$MR_REPO/compare/main...$sha"',
      'GET "/repos/$MR_REPO/tarball/$sha"',
    ]);
    expect(calls(src)).toHaveLength(9); // no other job calls GitHub
    for (const [t, fn, write] of [
      [open, 'run_open_pr() {', 'mr_call POST "/repos/$MR_REPO/pulls"'],
      [edit, 'run_edit_pr() {', 'mr_call PATCH'],
    ] as const) {
      const body = t.slice(t.indexOf(fn));
      const at = ['mr_begin "$w" "$2" || return 0', `mr_call ${LIST}`, 'mr_render "$w"', write].map(
        (x) => body.indexOf(x),
      );
      expect(at.every((x) => x >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at); // begin → lookup → render → write
    }
    // edit-pr's write carries the text only, and only for a PR whose number the Mac read itself.
    expect(edit).toContain(`jq -c '.params | if has("title") then {title, body} else {body} end'`);
    expect(edit).toContain('n="$(jq -r .number <<<"$pr")"');
    expect(edit).not.toMatch(/\.params\.(number|state|base|draft)/);
    expect(src).toContain('MR_REPO="radatta/aperture"');
    expect(src.match(/\bcurl\b/g)).toHaveLength(1);
  });

  // The one job that runs code that isn't merged main (MAILROOM.md → The fixtures job): every tool it runs on that code goes
  // through sandbox-exec, the suite in a clean environment and under the cap, and the profile takes network, writes,
  // home folders and the Keychain away.
  it('the fixtures job: sandboxed, clean environment, capped, no install change', () => {
    const fx = readFileSync(`${TOOLS_DIR}jobs/fixtures.sh`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const pin of [
      'FX_TIMEOUT=600',
      "FX_INSTALL_RE='^tools/mailroom/(install\\.sh|[^/]*\\.plist\\.tmpl)$'",
      'if [ "$n" -ge 300 ]; then mr_emit rejected DIFF_TOO_LARGE; return 0; fi',
      "if ! command -v sandbox-exec >/dev/null 2>&1; then printf 'error SANDBOX_MISSING {}\\n'; return 0; fi",
      'exec sandbox-exec -f "$MR_P.sb" tar -xzf "$1/src.tgz" -C "$1/src" --strip-components 1',
      'if ! fx_cap 120 fx_unpack "$t" >/dev/null 2>&1',
      'fx_cap "$FX_TIMEOUT" fx_suite "$t" >"$MR_P.out" 2>&1 </dev/null || rc=$?',
      'ulimit -f 1048576',
      'kill -KILL -- "-$pid"',
      'exec sandbox-exec -f "$MR_P.sb" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin',
      'if ! [[ "$t" =~ ^/[A-Za-z0-9/._-]+$ ]]; then',
    ])
      expect(fx).toContain(pin);
    // tar and bash run only inside sandbox-exec: no line starts either as a command on its own.
    const runs = fx
      .split('\n')
      .filter((l) => /(?:^|[;&|(]|\bthen|\bdo|!)\s*(?:\/bin\/|\/usr\/bin\/)?(bash|tar)\s/.test(l));
    expect(runs.filter((l) => !l.includes('sandbox-exec -f "$MR_P.sb"'))).toEqual([]);
    expect(fx.match(/\bsandbox-exec -f "\$MR_P\.sb" \S+/g)).toEqual([
      'sandbox-exec -f "$MR_P.sb" tar', // the unpack
      'sandbox-exec -f "$MR_P.sb" /usr/bin/env', // the suite, under fx_cap
      'sandbox-exec -f "$MR_P.sb" /usr/bin/true)', // the preflight: a profile this macOS won't compile is SANDBOX_FAILED
    ]);
    for (const banned of ['eval ', 'sh -c', 'bash -c', 'source ', '. "$t'])
      expect(fx).not.toContain(banned);
  });

  // The whole profile, rendered by fx_profile, in order (SBPL: the last matching rule wins), for a temp dir /T.
  it('the fixtures sandbox profile, exactly', () => {
    const out = execFileSync(
      'bash',
      ['-c', '. "$1"; fx_profile /T', '_', `${TOOLS_DIR}jobs/fixtures.sh`],
      {
        encoding: 'utf8',
      },
    );
    expect(out.trim().split('\n')).toEqual([
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(deny file-write*)',
      '(allow file-write* (subpath "/T") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
      '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/System/Volumes/Data/Users"))',
      '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
      '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.pasteboard.1") (global-name "com.apple.CoreSimulator.CoreSimulatorService"))',
      '(deny appleevent-send)',
      '(deny job-creation)',
      '(deny signal)',
      '(allow signal (target same-sandbox))',
      '(deny process-exec (literal "/usr/bin/security") (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/pbpaste") (literal "/usr/bin/pbcopy") (literal "/usr/bin/xcrun") (literal "/usr/bin/defaults"))',
    ]);
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

  // Two launchd agents on one inbox (MAILROOM.md → Lanes): only sim and fixtures are slow, each lane has its own lock, and the one
  // template renders a valid agent per lane.
  it('lanes: sim and fixtures are slow, a lock per lane, two agents from one template', () => {
    const runner = readFileSync(`${TOOLS_DIR}runner.sh`, 'utf8');
    for (const pin of [
      'SLOW_JOBS="sim fixtures"',
      'FAST_JOBS="clip"',
      "SLOW_RE='^[0-9]{8}T[0-9]{6}Z-(ios|fx)-'",
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
