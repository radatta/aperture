// The Mac stats agent (tools/macstats/, docs/ops/TOWER.md → Mac stats): its parse on recorded macOS output, its
// out-dir pin, and static checks of the trust boundary — like runner-fixtures.test.ts for the mailroom.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMacStats } from './tower/health.ts';

const ROOT = join(import.meta.dirname, '../../..');
const AGENT = join(ROOT, 'tools/macstats/macstats.sh');
const INSTALL = join(ROOT, 'tools/macstats/install.sh');
const FX = join(import.meta.dirname, 'tower/fixtures/mac');
const render = (dir: string) =>
  JSON.parse(execFileSync('bash', [AGENT, '--render', dir], { encoding: 'utf8' }));
const PM = ['pmset-batt.txt', 'pmset.txt', 'pmset-therm.txt'];
// the one true awk is macOS's; the container may have it (`apt-get install original-awk`), CI doesn't (skipped there)
const ONE_TRUE_AWK = existsSync('/usr/bin/original-awk') ? '/usr/bin/original-awk' : null;
// a copy of the fixtures, edited; null deletes a file
const variant = (edit: (f: Record<string, string | null>) => void) => {
  const d = mkdtempSync(join(tmpdir(), 'mac-'));
  cpSync(FX, d, { recursive: true });
  const f: Record<string, string | null> = {};
  for (const n of PM.concat(['vm_stat.txt', 'sysctl.txt', 'ps.txt']))
    f[n] = readFileSync(join(d, n), 'utf8');
  edit(f);
  for (const [n, t] of Object.entries(f))
    if (t === null) rmSync(join(d, n));
    else writeFileSync(join(d, n), t);
  return d;
};

describe('macstats.sh --render', () => {
  it('turns vm_stat / sysctl / ps into the JSON the tower reads (page size 16384, worked by hand)', () => {
    const j = render(FX);
    // free = (65536 + 6400 speculative) × 16 KiB = 1124 MiB; used = active 8192 + wired 3072 + compressor 4096
    expect(j).toMatchObject({
      v: 1,
      memTotalMiB: 36864,
      mem: {
        freeMiB: 1124,
        activeMiB: 8192,
        inactiveMiB: 4096,
        wiredMiB: 3072,
        compressedMiB: 4096,
        usedMiB: 15360,
        freePct: 3,
        pressure: 'warn',
      },
      swap: { totalMiB: 2048, usedMiB: 1024 },
      load: [3.21, 2.75, 2.4],
      cpus: 12,
      vm: { pid: 512, rssMiB: 22528, comm: 'com.apple.Virtualization.VirtualMachine' },
    });
    expect(() => parseMacStats(JSON.stringify(j))).not.toThrow();
  });

  it('no hypervisor process is vm: null; pressure 4 is critical; 4 KiB pages', () => {
    const d = variant((f) => {
      f['ps.txt'] = '    1  12000 /sbin/launchd\n';
      f['sysctl.txt'] = f['sysctl.txt']!.replace(/\n2\n$/, '\n4\n');
      f['vm_stat.txt'] = f['vm_stat.txt']!.replace('16384', '4096');
    });
    const j = render(d);
    expect(j.vm).toBeNull();
    expect(j.mem.pressure).toBe('critical');
    expect(j.mem.activeMiB).toBe(2048);
  });

  it('an unreadable swap line is null; a G unit converts', () => {
    const g = variant((f) => {
      f['sysctl.txt'] = f['sysctl.txt']!.replace(
        'total = 2048.00M  used = 1024.50M',
        'total = 2.00G  used = 1.00G',
      );
    });
    expect(render(g).swap).toEqual({ totalMiB: 2048, usedMiB: 1024 });
    const bad = variant((f) => {
      f['sysctl.txt'] = f['sysctl.txt']!.replace(/total = .*\n/, 'swap off\n');
    });
    expect(render(bad).swap).toBeNull();
  });

  it('unreadable vm_stat fails loudly', () => {
    const d = variant((f) => {
      f['vm_stat.txt'] =
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: lots.\n';
    });
    const r = spawnSync('bash', [AGENT, '--render', d], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unreadable vm_stat/);
  });
});

// F120: pmset -g batt / -g / -g therm, no sudo. Shapes: docs/ops/TOWER.md → Mac stats.
describe('macstats.sh --render: power', () => {
  const batt = (line: string, from = 'AC Power') =>
    `Now drawing from '${from}'\n -InternalBattery-0 (id=1234567)\t${line} present: true\n`;
  const power = (edit: (f: Record<string, string | null>) => void) => render(variant(edit)).power;

  it('the 11-17 shape: AC, 12% charging, 9:02 to full; LPM 0; nothing recorded', () => {
    expect(render(FX).power).toEqual({
      source: 'ac',
      batteryPct: 12,
      state: 'charging',
      remainingMin: 542,
      lowPowerMode: false,
      thermal: {
        warningLevel: null,
        performanceWarningLevel: null,
        cpuSpeedLimit: null,
        cpuSchedulerLimit: null,
        cpuAvailableCpus: null,
      },
    });
  });

  it('on battery: discharging with an estimate, and "(no estimate)"', () => {
    expect(
      power(
        (f) => (f['pmset-batt.txt'] = batt('24%; discharging; 2:10 remaining', 'Battery Power')),
      ),
    ).toMatchObject({ source: 'battery', batteryPct: 24, state: 'discharging', remainingMin: 130 });
    expect(
      power(
        (f) => (f['pmset-batt.txt'] = batt('88%; discharging; (no estimate)', 'Battery Power')),
      ),
    ).toMatchObject({
      source: 'battery',
      batteryPct: 88,
      state: 'discharging',
      remainingMin: null,
    });
  });

  it('charged, finishing charge, "AC attached; not charging", and spaces instead of the tab', () => {
    expect(
      power((f) => (f['pmset-batt.txt'] = batt('100%; charged; 0:00 remaining'))),
    ).toMatchObject({
      batteryPct: 100,
      state: 'charged',
      remainingMin: 0,
    });
    expect(
      power((f) => (f['pmset-batt.txt'] = batt('99%; finishing charge; 0:05 remaining'))),
    ).toMatchObject({
      state: 'finishing',
      remainingMin: 5,
    });
    expect(
      power((f) => (f['pmset-batt.txt'] = batt('80%; AC attached; not charging'))),
    ).toMatchObject({
      batteryPct: 80,
      state: 'not-charging',
      remainingMin: null,
    });
    expect(
      power(
        (f) =>
          (f['pmset-batt.txt'] =
            "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)        93%; charging; 0:32 remaining present: true\n"),
      ),
    ).toMatchObject({ batteryPct: 93, state: 'charging', remainingMin: 32 });
  });

  it('the older shape with no id and no present: still parses', () => {
    expect(
      power(
        (f) =>
          (f['pmset-batt.txt'] =
            "Now drawing from 'Battery Power'\n -InternalBattery-0\t90%; discharging; 6:32 remaining\n"),
      ),
    ).toMatchObject({ source: 'battery', batteryPct: 90, state: 'discharging', remainingMin: 392 });
  });

  it('no internal battery (a desktop Mac) is source ac, the battery fields null', () => {
    expect(power((f) => (f['pmset-batt.txt'] = "Now drawing from 'AC Power'\n"))).toMatchObject({
      source: 'ac',
      batteryPct: null,
      state: null,
      remainingMin: null,
    });
  });

  it('lowpowermode 1 is true; no such line is null', () => {
    expect(
      power(
        (f) =>
          (f['pmset.txt'] = f['pmset.txt']!.replace(/lowpowermode +0/, 'lowpowermode         1')),
      ).lowPowerMode,
    ).toBe(true);
    expect(
      power((f) => (f['pmset.txt'] = f['pmset.txt']!.replace(/.*lowpowermode.*\n/, '')))
        .lowPowerMode,
    ).toBeNull();
  });

  it('a recorded CPU power status and warning levels are read; an odd level is "recorded"', () => {
    const t = power(
      (f) =>
        (f['pmset-therm.txt'] =
          '2026-11-17 10:00:00 -0800 CPU Power notify\n\tCPU_Scheduler_Limit \t= 100\n\tCPU_Available_CPUs \t= 8\n\tCPU_Speed_Limit \t= 80\nThermal Warning Level = 2\nPerformance Warning Level: elevated\n'),
    ).thermal;
    expect(t).toEqual({
      warningLevel: 2,
      performanceWarningLevel: 'recorded',
      cpuSpeedLimit: 80,
      cpuSchedulerLimit: 100,
      cpuAvailableCpus: 8,
    });
  });

  it('missing pmset files give nulls, never a failed render', () => {
    const j = render(variant((f) => PM.forEach((n) => (f[n] = null))));
    expect(j.power).toEqual({
      source: null,
      batteryPct: null,
      state: null,
      remainingMin: null,
      lowPowerMode: null,
      thermal: null,
    });
    expect(j.mem.usedMiB).toBe(15360);
  });

  it('powermode (a Mac with High Power Mode): 1 is Low Power Mode, 0 and 2 are not; lowpowermode wins', () => {
    const pm = (lines: string) => power((f) => (f['pmset.txt'] = lines)).lowPowerMode;
    expect(pm(' powermode            1\n')).toBe(true);
    expect(pm(' powermode            2\n')).toBe(false);
    expect(pm(' powermode            0\n')).toBe(false);
    expect(pm(' lowpowermode         0\n powermode            1\n')).toBe(false);
  });

  // F205: bash's printf writes a line at a time, so an awk that exits early on a pipe from it can SIGPIPE a later
  // write — exit 141 under pipefail (9 of 2,000 renders under load, 2026-11-17). Such an awk reads a here-string.
  it('no awk that exits early reads a pipe from printf', () => {
    const sh = readFileSync(AGENT, 'utf8');
    const fed = [...sh.matchAll(/printf '%s\\n' "\$\w+" \| awk[^']*'([^']*)'/g)];
    expect(fed.filter((m) => /\bexit\b/.test(m[1]!)).map((m) => m[0].slice(0, 60))).toEqual([]);
    // the anchor: the page-size and page-count awks read $VM as a here-string (a rename would hide them above)
    expect(sh.match(/<<<"\$VM"/g)).toHaveLength(2);
  });

  // macOS runs the one true awk, not this container's mawk/gawk: the same fixtures through it, when installed
  it.skipIf(!ONE_TRUE_AWK)('BSD awk (original-awk) renders the same power', () => {
    const t = mkdtempSync(join(tmpdir(), 'oawk-'));
    mkdirSync(join(t, 'bin'));
    symlinkSync(ONE_TRUE_AWK!, join(t, 'bin/awk'));
    writeFileSync(
      join(t, 'macstats.sh'),
      readFileSync(AGENT, 'utf8').replace(
        /^export LC_ALL=C PATH=/m,
        `export LC_ALL=C PATH=${join(t, 'bin')}:`,
      ),
    );
    const therm =
      '2026-11-17 10:00:00 -0800 CPU Power notify\n\tCPU_Scheduler_Limit \t= 100\n\tCPU_Available_CPUs \t= 8\n\tCPU_Speed_Limit \t= 80\nThermal Warning Level = 2\n';
    for (const d of [
      FX,
      variant((f) => {
        f['pmset-batt.txt'] =
          "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t80%; AC attached; not charging present: true\n";
        f['pmset-therm.txt'] = therm;
        f['pmset.txt'] = ' powermode 1\n';
      }),
    ]) {
      const r = (agent: string) =>
        JSON.parse(execFileSync('bash', [agent, '--render', d], { encoding: 'utf8' })).power;
      expect(r(join(t, 'macstats.sh'))).toEqual(r(AGENT));
    }
  });

  it('CRLF line ends read the same; a UPS is source ups', () => {
    const crlf = render(
      variant((f) => {
        for (const n of PM) f[n] = f[n]!.replace(/\n/g, '\r\n');
        f['pmset.txt'] = f['pmset.txt']!.replace(/lowpowermode +0/, 'lowpowermode 1');
      }),
    ).power;
    expect(crlf).toMatchObject({
      source: 'ac',
      batteryPct: 12,
      remainingMin: 542,
      lowPowerMode: true,
    });
    expect(
      power((f) => (f['pmset-batt.txt'] = f['pmset-batt.txt']!.replace('AC Power', 'UPS Power')))
        .source,
    ).toBe('ups');
  });

  it('the battery id never reaches the JSON', () => {
    expect(JSON.stringify(render(FX))).not.toContain('1234567');
  });
});

describe('macstats.sh out-dir pin (runs before any macOS tool)', () => {
  const tick = (out: string, state: string) =>
    spawnSync('bash', [AGENT, out, state], { encoding: 'utf8' });

  it('a missing out dir logs once per change and writes nothing', () => {
    const t = mkdtempSync(join(tmpdir(), 'pin-'));
    const out = join(t, 'gone');
    const a = tick(out, join(t, 'state'));
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/out dir missing/);
    expect(tick(out, join(t, 'state')).stdout).toBe('');
    expect(readFileSync(join(t, 'state/last'), 'utf8').trim()).toBe('missing');
  });

  it('a symlinked out dir is refused, never written through', () => {
    const t = mkdtempSync(join(tmpdir(), 'pin-'));
    mkdirSync(join(t, 'real'));
    symlinkSync(join(t, 'real'), join(t, 'link'));
    expect(tick(join(t, 'link'), join(t, 'state')).stdout).toMatch(/not a plain directory/);
    expect(existsSync(join(t, 'real/mac-stats.json'))).toBe(false);
  });

  it('a directory (or a link to one) at the target is refused: mv would move into it', () => {
    const t = mkdtempSync(join(tmpdir(), 'pin-'));
    mkdirSync(join(t, 'out'));
    mkdirSync(join(t, 'elsewhere'));
    symlinkSync(join(t, 'elsewhere'), join(t, 'out/mac-stats.json'));
    expect(tick(join(t, 'out'), join(t, 'state')).stdout).toMatch(
      /refusing: .* is a directory or a link to one/,
    );
    expect(readFileSync(join(t, 'state/last'), 'utf8').trim()).toBe('target');
  });

  it('wrong argv is a usage error', () => {
    expect(spawnSync('bash', [AGENT], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('one real tick, macOS tools stubbed', () => {
  // a copy of the agent whose fixed PATH starts with stub vm_stat / sysctl / ps that print the fixtures
  function stubbed(pmset = false) {
    const t = mkdtempSync(join(tmpdir(), 'tick-'));
    const bin = join(t, 'bin');
    mkdirSync(bin);
    const sys = readFileSync(join(FX, 'sysctl.txt'), 'utf8').trimEnd().split('\n');
    const oids = [
      'hw.memsize',
      'hw.ncpu',
      'vm.loadavg',
      'vm.swapusage',
      'kern.memorystatus_vm_pressure_level',
    ];
    writeFileSync(join(bin, 'vm_stat'), `#!/bin/bash\ncat '${join(FX, 'vm_stat.txt')}'\n`, {
      mode: 0o755,
    });
    writeFileSync(join(bin, 'ps'), `#!/bin/bash\ncat '${join(FX, 'ps.txt')}'\n`, { mode: 0o755 });
    writeFileSync(
      join(bin, 'sysctl'),
      `#!/bin/bash\ncase "$2" in\n${oids.map((o, i) => `  ${o}) echo '${sys[i]}' ;;`).join('\n')}\n  *) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    if (pmset)
      writeFileSync(
        join(bin, 'pmset'),
        `#!/bin/bash\ncase "$2" in\n  batt) cat '${join(FX, 'pmset-batt.txt')}' ;;\n  therm) cat '${join(FX, 'pmset-therm.txt')}' ;;\n  '') cat '${join(FX, 'pmset.txt')}' ;;\n  *) exit 1 ;;\nesac\n`,
        { mode: 0o755 },
      );
    const agent = readFileSync(AGENT, 'utf8').replace(
      /^export LC_ALL=C PATH=/m,
      `export LC_ALL=C PATH=${bin}:`,
    );
    expect(agent).toContain(`PATH=${bin}:`);
    writeFileSync(join(t, 'macstats.sh'), agent);
    mkdirSync(join(t, 'out'));
    return t;
  }

  it('writes mac-stats.json, exits 0 with nothing on stderr, and leaves no temp file', () => {
    const t = stubbed();
    const r = spawnSync('bash', [join(t, 'macstats.sh'), join(t, 'out'), join(t, 'state')], {
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readdirSync(join(t, 'out'))).toEqual(['mac-stats.json']);
    const j = JSON.parse(readFileSync(join(t, 'out/mac-stats.json'), 'utf8'));
    expect(j).toMatchObject({ v: 1, mem: { usedMiB: 15360 }, cpus: 12 });
    // no pmset on this PATH (the tests run on Linux): power is all null, the tick still exits 0 and quiet
    expect(j.power).toMatchObject({ source: null, lowPowerMode: null, thermal: null });
    expect(readFileSync(join(t, 'state/last'), 'utf8').trim()).toBe('ok');
    // a second tick logs nothing (one log line per change) and still writes
    const r2 = spawnSync('bash', [join(t, 'macstats.sh'), join(t, 'out'), join(t, 'state')], {
      encoding: 'utf8',
    });
    expect([r2.status, r2.stdout, r2.stderr]).toEqual([0, '', '']);
  });

  it('with pmset there, a tick writes power', () => {
    const t = stubbed(true);
    const r = spawnSync('bash', [join(t, 'macstats.sh'), join(t, 'out'), join(t, 'state')], {
      encoding: 'utf8',
    });
    expect([r.status, r.stderr]).toEqual([0, '']);
    const j = JSON.parse(readFileSync(join(t, 'out/mac-stats.json'), 'utf8'));
    expect(j.power).toMatchObject({ source: 'ac', batteryPct: 12, lowPowerMode: false });
  });

  it('a link to a directory planted after the check is replaced by the rename, never moved into', () => {
    const t = stubbed();
    mkdirSync(join(t, 'elsewhere'));
    // re-plant the link right before the rename: the copy's mv runs after a hook that plants it
    const s = readFileSync(join(t, 'macstats.sh'), 'utf8').replace(
      '  mv -f "$MV_NOFOLLOW"',
      `  ln -s '${join(t, 'elsewhere')}' "$out/mac-stats.json"\n  mv -f "$MV_NOFOLLOW"`,
    );
    expect(s).toContain('ln -s');
    writeFileSync(join(t, 'macstats.sh'), s);
    const r = spawnSync('bash', [join(t, 'macstats.sh'), join(t, 'out'), join(t, 'state')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(readdirSync(join(t, 'elsewhere'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(t, 'out/mac-stats.json'), 'utf8')).v).toBe(1);
  });

  it('a link to a file at the target is replaced, not written through', () => {
    const t = stubbed();
    writeFileSync(join(t, 'victim'), 'keep');
    symlinkSync(join(t, 'victim'), join(t, 'out/mac-stats.json'));
    expect(
      spawnSync('bash', [join(t, 'macstats.sh'), join(t, 'out'), join(t, 'state')]).status,
    ).toBe(0);
    expect(readFileSync(join(t, 'victim'), 'utf8')).toBe('keep');
    expect(JSON.parse(readFileSync(join(t, 'out/mac-stats.json'), 'utf8')).v).toBe(1);
  });

  it('an unreadable cpu count and load are null, never 0 and []', () => {
    const d = variant((f) => {
      f['sysctl.txt'] = f['sysctl.txt']!.replace(/^12$/m, '').replace(/^\{.*\}$/m, '');
    });
    expect(render(d)).toMatchObject({ cpus: null, load: null });
  });
});

describe('the trust boundary, statically', () => {
  const agent = readFileSync(AGENT, 'utf8');
  const code = agent
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const install = readFileSync(INSTALL, 'utf8');
  const word = (w: string) => new RegExp(`\\b${w}\\b`);

  it('the agent makes no network call, runs no Keychain, git or gh, and sources nothing', () => {
    for (const w of ['curl', 'wget', 'nc', 'ssh', 'osascript', 'security', 'gh', 'git', 'eval'])
      expect(code).not.toMatch(word(w));
    expect(code).not.toMatch(/^\s*(\.|source)\s/m);
  });

  it('it never reads from the out dir: its one write there is mktemp in that dir, then mv -f', () => {
    expect(code).not.toMatch(/cat\s+"?\$out/);
    expect(code).not.toMatch(/<\s*"?\$out/);
    expect(code).toContain('tmp=$(mktemp "$out/.mac-stats.XXXXXX")');
    expect(code).toContain('mv -f "$MV_NOFOLLOW" "$tmp" "$out/mac-stats.json"');
    expect(code).toMatch(/Darwin\) MV_NOFOLLOW=-h ;;/);
  });

  it('bash 3.2 only: no mapfile, associative arrays or case-changing expansions', () => {
    for (const bad of [
      word('mapfile'),
      word('readarray'),
      /declare -A/,
      /\$\{[a-zA-Z_]+(,,|\^\^)\}/,
    ])
      expect(agent).not.toMatch(bad);
  });

  it('the installer reads only GitHub at the ref, with the token as a header fd, never on argv', () => {
    expect(install).toContain(`-H @<(printf 'Authorization: Bearer %s\\n' "$TOKEN")`);
    expect(install).toContain('security find-generic-password -s "$KEYCHAIN" -w');
    const urls = install.match(/https:\/\/[^\s"']+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls)
      expect(u.startsWith('https://api.github.com/repos/$REPO_SLUG/')).toBe(true);
    expect(install).toContain("NOT main's head");
    expect(install.trimEnd().split('\n').at(-1)).toMatch(/^main "\$@"/);
  });
});
