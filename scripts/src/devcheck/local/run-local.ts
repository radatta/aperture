// The local check — docs/ops/LOCAL-CHECK.md. The dev check's scenarios and pipeline against a local stack:
//   pnpm devcheck:local --tier smoke|delta|full|all [--scenario a,b] [--feature a,b]
// The real BFF + MCP edges in a child process behind a CloudFront stand-in, over a per-run in-memory table,
// with locally signed tokens; the app from `vite dev`. No dev lock, no deploy, no network past 127.0.0.1.
// A pre-flight before `pnpm bot deploy-dev`: a red run blocks the lock, a green one proves nothing about dev.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { freePort, startLocalServer, startVite, type Proc } from './server';
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
// lists report-<branch>.md and the CC done notes paste are renamed so a local run can never fill them.
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
  const scenarios = selectScenarios(args.tier, args.scenarios, SCENARIOS);
  const feature = selectFeature(args.feature, scenarios);
  const changed = await Promise.all([
    git(['diff', '--name-only', 'origin/main...HEAD']),
    git(['diff', '--name-only', 'HEAD']),
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
        // Set, so the agent-token and device-token paths reject as on dev rather than fall back to 'local'.
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
      makeApi: (token, fresh) => createApiClient({ fetch, token, fresh, ledger, run: runId }),
      makeMcp: (token) => createMcpClient({ fetch, token, ledger, run: runId }),
      now: Date.now,
      log,
    });
    // The iOS probe check (IOS-CHECK.md → Probe check): every iOS plan against the stub app, its own Vite.
    const probePort = await freePort();
    await startVite({
      worktree,
      track,
      port: probePort,
      env: {},
      logPath: join(out, 'vite-probe.log'),
    });
    const probes = await runProbes({
      origin: `http://127.0.0.1:${probePort}`,
      shotsDir,
      log: (m) => log(`ios-probe ${m}`),
    });
    const md = toLocalReport(renderReport(result)).replace(
      /^(Run `.*)$/m,
      `$1\nTarget: local (HEAD \`${head.slice(0, 7)}\` served by vite dev${dirty ? ', working tree dirty' : ''}) — dev remains the proof`,
    );
    writeFileSync(
      join(out, 'report.md'),
      `${md}\n## iOS probe check\n\n\`\`\`\n${probes.text}\n\`\`\`\n`,
    );
    writeFileSync(
      join(out, 'report.json'),
      JSON.stringify(
        { ...result, target: 'local', iosProbe: { ok: probes.ok, results: probes.results } },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `\nLOCAL ${statusLine(result)}\n${probes.text.split('\n')[0]}\nreport: ${join(out, 'report.md')}`,
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
