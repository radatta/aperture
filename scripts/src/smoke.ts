// @aperture/scripts — CI smoke runner. Invokes the deployed Lambda DIRECTLY (aws lambda invoke, the CI
// role has lambda:InvokeFunction) with a testMode payload per call. testMode → synthetic user + noop
// writes, so a run exercises the real Lambda→DynamoDB path end to end while touching no data, even
// against prod. Run: `tsx src/smoke.ts <stage>` (wired as the `smoke` package script).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SmokeCall {
  method: string;
  args: unknown[];
}

// Read-only methods — enough to prove auth-skip, dispatch, and the DynamoDB round-trip. Args are empty
// or a read range, so nothing could mutate even if the writes-object guarantee regressed. Each call must
// pass the BFF's argument check (lambdas/src/rpc/argSpecs.ts; smoke.test.ts runs it), or the deploy's
// smoke step goes red.
export const SMOKE_CALLS: SmokeCall[] = [
  { method: 'getSettings', args: [] },
  { method: 'listCategories', args: [] },
  { method: 'listTasks', args: [] },
  { method: 'getCalibration', args: [{ from: '2026-01-01', to: '2026-01-07' }] },
  // Calendar read: proves the gated gateway no-ops under testMode (no SSM token read, no Google fetch).
  { method: 'getGoogleStatus', args: [] },
  // Also proves the S3 SDK loaded at cold start (listAttachments is a plain read; no presign, no bytes).
  { method: 'listAttachments', args: [] },
  // Finance: proves the finance service path, and that the Lambda SDK client (the sync invoker) and the
  // live Plaid gateway load at cold start — testMode swaps both for noops, so no SSM read, no Plaid call.
  { method: 'listFinanceRules', args: [] },
];

// The direct-invoke event shape the handler understands (no requestContext.http → skips the origin gate).
export function buildEvent(call: SmokeCall): string {
  return JSON.stringify({
    rawPath: `/api/${call.method}`,
    body: JSON.stringify({ testMode: true, args: call.args }),
  });
}

export interface InvokeResult {
  statusCode?: number;
  body?: string;
}

export function assertHealthy(call: SmokeCall, result: InvokeResult): void {
  if (result.statusCode !== 200) {
    throw new Error(
      `${call.method}: expected 200, got ${result.statusCode} — ${result.body ?? '(no body)'}`,
    );
  }
  const parsed: unknown = result.body ? JSON.parse(result.body) : null;
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw new Error(
      `${call.method}: handler error — ${String((parsed as { error: unknown }).error)}`,
    );
  }
}

function invoke(stage: string, call: SmokeCall): InvokeResult {
  const out = join(mkdtempSync(join(tmpdir(), 'aperture-smoke-')), 'out.json');
  execFileSync(
    'aws',
    [
      'lambda',
      'invoke',
      '--function-name',
      `aperture-bff-${stage}`,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--payload',
      buildEvent(call),
      out,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return JSON.parse(readFileSync(out, 'utf8')) as InvokeResult;
}

export function runSmoke(stage: string): void {
  console.log(`▶ Smoke ${stage} — ${SMOKE_CALLS.length} calls (testMode, no writes)`);
  for (const call of SMOKE_CALLS) {
    const result = invoke(stage, call);
    assertHealthy(call, result);
    console.log(`  ✓ ${call.method} → ${result.statusCode}`);
  }
  console.log(`✓ Smoke ${stage} passed`);
}

if (process.argv[1]?.endsWith('smoke.ts')) runSmoke(process.argv[2] ?? 'dev');
