// The local check — docs/ops/LOCAL-CHECK.md. The dev check's scenarios and pipeline against a local stack:
//   pnpm devcheck:local --tier smoke|delta|full|all [--scenario a,b] [--feature a,b]
// The real BFF + MCP edges in a child process behind a CloudFront stand-in, over a per-run in-memory table,
// with locally signed tokens; the app from `vite dev`. No dev lock, no deploy, no network past 127.0.0.1.
// A pre-flight before `pnpm bot deploy-dev`: a red run blocks the lock, a green one proves nothing about dev.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createApiClient } from '../api';
import { launch, loadPlaywright } from '../browser';
import { useLocalOrigin, worktreeRoot } from '../config';
import { openLedger } from '../ledger';
import { SHELL, readCheckedSession } from '../login';
import { matrixProblems } from '../matrix';
import { createMcpClient } from '../mcp';
import { assertMcpTestUser } from '../mcp-login';
import { exitCode, runPipeline, type BrowserSession } from '../pipeline';
import { renderReport, statusLine, type RunResult } from '../report';
import { parseArgs, shasFor } from '../run';
import { SCENARIOS, selectFeature, selectScenarios, slowScenarios } from '../scenarios/index';
import { DevcheckError } from '../errors';
import { runProbes } from '../../ios-probe/run';
import { freePort, startLocalServer, startVite, viteReloads, type Proc } from './server';
import { localSkip } from './skips';
import {
  LOCAL_CLAUDE_CLIENT,
  LOCAL_APP_CLIENT,
  LOCAL_POOL_ID,
  localMcpSession,
  makeLocalAuth,
  seededState,
} from './target';
import { cognitoAuthority } from '../token';

const exec = promisify(execFile);

// The dev report's wording, retitled: every "on dev" a local report would claim is "locally" here, and the two
// lists report-<branch>.md and the [pr-open] message paste are renamed so a local run can never fill them.
export const LOCAL_NOT_PASTE = '— not a paste list: dev’s report is';
export function toLocalReport(md: string): string {
  return md
    .replace(/^# Dev check — (.*)$/m, '# Local check — $1 (pre-flight; dev remains the proof)')
    .replaceAll('Not proven on dev', 'Not proven locally')
    .replaceAll('Proven on dev', 'Proven locally')
    .replaceAll('proven on dev', 'proven locally')
    .replace(/^(#+) You don't need to test$/gm, `$1 Passed locally ${LOCAL_NOT_PASTE}`)
    .replace(/^(#+) Needs you$/gm, `$1 Needs you (local run) ${LOCAL_NOT_PASTE}`)
    .replaceAll('Deferred (slow tier)', 'Deferred (slow tier, or runs on dev)')
    .replaceAll(
      '_Not run: the branch touches none of these scenarios’ slow paths and no `--feature` names them. `--tier all` runs them._',
      '_Not run here: rows marked `local: …` only dev can prove — they run in the dev check; the rest are slow steps outside this branch’s paths (`--tier all` runs them)._',
    );
}

export const localRunDir = (worktree: string, runId: string): string =>
  resolve(worktree, 'localNotes', 'devcheck-local', runId);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.sha) throw new Error('--sha is a dev flag: the local check always serves the worktree');
  const worktree = worktreeRoot();
  const git = async (a: string[]) => (await exec('git', a, { cwd: worktree })).stdout.trim();
  const head = await git(['rev-parse', 'HEAD']);
  const { scenarioSha } = shasFor(
    head,
    !!(await git(['--no-optional-locks', 'status', '--porcelain', '--', ':/scripts/src/devcheck'])),
  );
  const dirty = !!(await git(['--no-optional-locks', 'status', '--porcelain']));
  // The tree's uncommitted state, to tell whether it changed under the run (Vite no longer reloads on an edit, but
  // a module first requested after one is served edited).
  // A stamp that can't be taken (a diff past the buffer) is null and compares as unchanged.
  const treeStamp = async (): Promise<string | null> => {
    const out = (a: string[]) =>
      exec('git', ['--no-optional-locks', ...a], { cwd: worktree, maxBuffer: 64 << 20 }).then(
        (r) => r.stdout,
      );
    try {
      const h = createHash('sha256').update(await out(['diff', 'HEAD', '--binary']));
      // Untracked files by name, size and mtime: an edit to one (a new test between rounds) moves the stamp too.
      for (const f of (await out(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0'))
        if (f) {
          const st = statSync(join(worktree, f), { throwIfNoEntry: false });
          h.update(`${f}\0${st?.size}\0${st?.mtimeMs}\n`);
        }
      return h.digest('hex');
    } catch {
      return null;
    }
  };
  const treeAtStart = await treeStamp();
  const scenarios = selectScenarios(args.tier, args.scenarios, SCENARIOS);
  const feature = selectFeature(args.feature, scenarios);
  const changed = await Promise.all([
    git(['diff', '--name-only', '--no-renames', 'origin/main...HEAD']),
    git(['diff', '--name-only', '--no-renames', 'HEAD']),
  ]).then(
    (outs) => [...new Set(outs.flatMap((o) => o.split('\n').filter(Boolean)))],
    () => null,
  );
  const slow = slowScenarios(args.tier, feature, scenarios, changed);
  const gaps = matrixProblems(SCENARIOS, worktree, {
    exists: existsSync,
    read: (p) => readFileSync(p, 'utf8'),
  });
  if (gaps.length) throw new DevcheckError('MATRIX_GAP', gaps.join('\n  '));
  const pw = loadPlaywright();

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${args.tier}`;
  const out = localRunDir(worktree, runId);
  const shotsDir = join(out, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const log = (msg: string) => console.log(`[devcheck:local] ${msg}`);
  // Tracked from spawn, not from ready: a kill during startup must still stop a child that is booting.
  const procs: Proc[] = [];
  const track = (p: Proc) => void procs.push(p);
  const stopAll = async () => {
    for (const p of [...procs].reverse()) await p.stop().catch(() => undefined); // vite, then the server
  };
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)
    process.once(sig, () => void stopAll().then(() => process.exit(code)));
  // A crash (an unhandled rejection, a thrown handler) skips finally: never leave the children in the shared container.
  process.once('exit', () => procs.forEach((p) => p.killNow()));

  try {
    const auth = makeLocalAuth();
    const vitePort = await freePort();
    const origin = `http://127.0.0.1:${vitePort}`;
    const t0 = Date.now();
    const server = await startLocalServer({
      worktree,
      track,
      logPath: join(out, 'server.log'),
      env: {
        ORIGIN_SECRET: auth.originSecret,
        APP_URL: origin,
        LOCAL_POOL_ID,
        LOCAL_CLAUDE_CLIENT_ID: LOCAL_CLAUDE_CLIENT,
        LOCAL_JWKS: JSON.stringify(auth.jwks),
        // Required: the server runs strict (STAGE=dev, lambdas/src/auth/strict.ts), so an unset token would refuse
        // its path. Random, so the token paths reject as on dev; the run never presents them.
        AGENT_TOKEN: randomBytes(32).toString('hex'),
        DEVICE_TOKEN: randomBytes(32).toString('hex'),
      },
    });
    await startVite({
      worktree,
      track,
      port: vitePort,
      edgePort: server.port,
      logPath: join(out, 'vite.log'),
      env: {
        VITE_API_MODE: 'http',
        VITE_API_BASE: '',
        VITE_COGNITO_AUTHORITY: cognitoAuthority(LOCAL_POOL_ID),
        VITE_COGNITO_CLIENT_ID: LOCAL_APP_CLIENT,
        VITE_BUILD_SHA: head,
      },
    });
    const viteLog = join(out, 'vite.log');
    let viteMark: number | null = null; // vite.log's bytes once signed in: the first load's optimizer reload comes before
    useLocalOrigin(origin);
    log(
      `run ${runId}: ${scenarios.map((s) => s.id).join(', ')}${feature.length ? ` (feature: ${feature.join(', ')})` : ''} — server :${server.port} (pid ${server.proc.pid}), app ${origin}, up in ${Date.now() - t0} ms → ${out}`,
    );
    const statePath = join(out, 'state.json');
    writeFileSync(statePath, JSON.stringify(seededState(auth, origin)));
    const ledger = openLedger(join(out, 'ledger.jsonl'));
    const fetchShell = async () =>
      (await fetch(`${origin}/`, { signal: AbortSignal.timeout(15_000) })).text();

    const result: RunResult = await runPipeline({
      runId,
      tier: args.tier,
      feature,
      expectedSha: head,
      scenarioSha,
      scenarios,
      ledger,
      shotsDir,
      slow,
      skip: localSkip,
      checkSessions: true,
      fetchShell,
      async openBrowser(): Promise<BrowserSession> {
        const { browser, context } = await launch(pw, statePath);
        const page = await context.newPage();
        // Nothing leaves the machine: a request off the run's origin (a scenario still built on the dev
        // origin, a third-party asset) is refused before it is sent.
        await page.route(
          (u) => u.origin !== origin,
          (route) => route.abort('blockedbyclient'),
        );
        return {
          page,
          async signIn() {
            // Vite optimises dependencies on the first load and may reload once; the shell settles after.
            for (let i = 0; i < 2; i++) {
              await page.goto(`${origin}/tasks`, { waitUntil: 'domcontentloaded' });
              await page.locator(SHELL).waitFor({ timeout: 60_000 });
            }
            viteMark = statSync(viteLog).size;
            const s = await readCheckedSession(page, auth.env);
            if (!s)
              throw new DevcheckError(
                'WRONG_USER',
                'signed-in shell but no seeded session in localStorage',
              );
            return s;
          },
          readSession: () => readCheckedSession(page, auth.env),
          async signInMcp() {
            const s = localMcpSession(auth);
            assertMcpTestUser(s, auth.env);
            return s;
          },
          close: () => browser.close(),
        };
      },
      makeApi: (token, fresh, onAnswer) =>
        createApiClient({ fetch, token, fresh, ledger, run: runId, onAnswer }),
      makeMcp: (token) => createMcpClient({ fetch, token, ledger, run: runId }),
      now: Date.now,
      log,
    });
    // What a step failing mid-run may have failed on instead of the code: a reload Vite did, or the tree moving.
    // Never signed in: no step ran on the page, and the first load's reload is expected.
    const reloads =
      viteMark === null
        ? []
        : viteReloads(readFileSync(viteLog).subarray(viteMark).toString('utf8'));
    const treeAtEnd = await treeStamp();
    const treeChanged = !!treeAtStart && !!treeAtEnd && treeAtEnd !== treeAtStart;
    const notes = [
      ...(reloads.length
        ? [
            `**Vite reloaded the page mid-run** (${reloads.length}): ${reloads.map((l) => `\`${l}\``).join(', ')} — a step failing near one failed on the reload`,
          ]
        : []),
      ...(treeChanged
        ? [
            '**The working tree changed during the run** — a module first loaded after the edit was served edited; rerun on a still tree',
          ]
        : []),
    ];
    const md = toLocalReport(renderReport(result)).replace(
      /^(Run `.*)$/m,
      `$1\nTarget: local (HEAD \`${head.slice(0, 7)}\` served by vite dev${dirty ? ', working tree dirty' : ''}) — dev remains the proof${notes.map((n) => `\n${n}`).join('')}`,
    );
    const write = (probe?: { ok: boolean; text: string; results: unknown[] }) => {
      writeFileSync(
        join(out, 'report.md'),
        probe ? `${md}\n## iOS probe check\n\n\`\`\`\n${probe.text}\n\`\`\`\n` : md,
      );
      const iosProbe = probe ? { iosProbe: { ok: probe.ok, results: probe.results } } : {};
      writeFileSync(
        join(out, 'report.json'),
        JSON.stringify(
          { ...result, target: 'local', viteReloads: reloads, treeChanged, ...iosProbe },
          null,
          2,
        ) + '\n',
      );
    };
    write();
    // Then the iOS probe check (IOS-CHECK.md → Probe check) on its own stub Vite. The scenarios' report is written
    // first, so a probe crash can't lose it; the crash is the probe's failure, reported as one.
    const probes = await (async () => {
      const port = await freePort();
      const probeLog = join(out, 'vite-probe.log');
      await startVite({ worktree, track, port, env: {}, logPath: probeLog });
      const p = await runProbes({
        origin: `http://127.0.0.1:${port}`,
        shotsDir,
        log: (m) => log(`ios-probe ${m}`),
      });
      // open()'s first-load optimizer reload is expected; an edit's reload isn't.
      const edits = viteReloads(readFileSync(probeLog, 'utf8')).filter((l) =>
        /page reload/i.test(l),
      );
      return edits.length
        ? { ...p, text: `${p.text}\nVite reloaded the probe's page: ${edits.join('; ')}` }
        : p;
    })().catch((err: unknown) => ({
      ok: false,
      text: `iOS probe check: FAIL — it couldn't run: ${err instanceof Error ? err.message : String(err)}`,
      results: [],
    }));
    write(probes);
    console.log(
      `\nLOCAL ${statusLine(result)}${probes.ok ? '' : ' — iOS PROBES FAILED'}\n${probes.text.split('\n')[0]}\nreport: ${join(out, 'report.md')}`,
    );
    return Math.max(exitCode(result), probes.ok ? 0 : 1);
  } finally {
    await stopAll();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
