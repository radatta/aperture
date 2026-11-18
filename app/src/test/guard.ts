// The first setupFile, importing nothing else, so the guard is in place before any module setup.ts loads could keep
// a reference to the unguarded console.
import { installConsoleGuard } from '@aperture/shared/console-guard';

// A test that reaches console.error/console.warn fails (docs/product/CONVENTIONS.md → the console guard).
installConsoleGuard();
// jsdom reports its own errors ("Not implemented: …", uncaught errors) to Node's console, past vitest's capture and
// the guard; send them through console.error, looked up per call so a test's spy still wins.
const vc = (globalThis as unknown as { jsdom: { virtualConsole: VirtualConsoleLike } }).jsdom
  .virtualConsole;
type JsdomError = Error & { type?: string; cause?: unknown };
type VirtualConsoleLike = {
  removeAllListeners(e: string): void;
  on(e: string, f: (err: JsdomError) => void): void;
};
vc.removeAllListeners('jsdomError');
vc.on('jsdomError', (e) =>
  console.error(
    e.type === 'unhandled-exception' && e.cause instanceof Error ? e.cause.stack : e.message,
  ),
);
