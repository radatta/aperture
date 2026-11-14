// The Mac stats agent (tools/macstats/, docs/ops/TOWER.md → Mac stats): its parse on recorded macOS output, its
// out-dir pin, and static checks of the trust boundary — like runner-fixtures.test.ts for the mailroom.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const variant = (edit: (f: Record<string, string>) => void) => {
  const d = mkdtempSync(join(tmpdir(), 'mac-'));
  cpSync(FX, d, { recursive: true });
  const f: Record<string, string> = {};
  for (const n of ['vm_stat.txt', 'sysctl.txt', 'ps.txt']) f[n] = readFileSync(join(d, n), 'utf8');
  edit(f);
  for (const [n, t] of Object.entries(f)) writeFileSync(join(d, n), t);
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

  it('wrong argv is a usage error', () => {
    expect(spawnSync('bash', [AGENT], { encoding: 'utf8' }).status).toBe(2);
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
    expect(code).toContain('mv -f "$tmp" "$out/mac-stats.json"');
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
