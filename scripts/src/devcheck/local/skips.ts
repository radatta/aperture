// What the local check leaves to dev (docs/ops/LOCAL-CHECK.md → What runs locally): a scenario or step named
// here is deferred with its reason, and every `ios` step is the Mac's. Central for now so no scenario file
// changes mid-wave; skips.test.ts fails the gate when a named scenario or step no longer exists.
export const LOCAL_SKIPS: Record<string, { steps?: string[]; reason: string }> = {
  'ios-standalone': { reason: 'local: the iOS Simulator is the Mac’s — runs on dev' },
  'flux-perf': {
    reason:
      'local: the service-worker precache and brotli wasm are the CloudFront build’s — runs on dev',
  },
  'attachment-delete': {
    reason: 'local: presigned S3 URLs and the dev Files bucket — runs on dev',
  },
  'category-suggest': {
    steps: ['real-review', 'real-named', 'real-auto'],
    reason: 'local: the real Haiku parse is dev’s (parsing is off locally) — runs on dev',
  },
  'timed-reminders': {
    steps: [
      'ui-health',
      'fuse-test',
      'fuse-ping',
      'server-test-sent',
      'fuse-device',
      'api-e2e-sent',
    ],
    reason:
      'local: the push-dispatch poller’s minute ticks and the push services are dev’s — runs on dev',
  },
  finance: { reason: 'local: the Plaid Sandbox fixture bank is dev’s — runs on dev' },
};

export const IOS_LOCAL = 'local: the iOS Simulator is the Mac’s — runs on dev';

export function localSkip(scenario: string, step: { id: string; entry: string }): string | null {
  if (step.entry === 'ios') return IOS_LOCAL;
  const s = LOCAL_SKIPS[scenario];
  if (!s) return null;
  return !s.steps || s.steps.includes(step.id) ? s.reason : null;
}
