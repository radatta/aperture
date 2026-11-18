// Test support: a test that reaches console.error or console.warn fails, so noise a green run would bury shows up
// (docs/product/CONVENTIONS.md → the console guard). Plain wrappers, not vi.spyOn, so vi.restoreAllMocks() leaves
// them in place. They only record — never throw — so nothing breaks inside React's error path or a promise callback;
// the test's afterEach calls failOnConsoleNoise(), which throws the list. A test that expects output spies console
// with mockImplementation (the spy sits above the wrapper) and asserts on it.

type Level = 'error' | 'warn';
type Call = { level: Level; text: string };

const calls: Call[] = [];
let allow: RegExp[] = [];
let original: Record<Level, typeof console.error> | null = null;

// console's own substitutions (%s and friends), so React's format-string warnings read as React printed them.
const show = (a: unknown): string => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
};
export function formatConsoleArgs(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== 'string') return args.map(show).join(' ');
  const text = first.replace(/%[sdifoOc%]/g, (m) =>
    m === '%%' ? '%' : m === '%c' ? (rest.shift(), '') : show(rest.shift()),
  );
  return [text, ...rest.map(show)].join(' ');
}

const record =
  (level: Level) =>
  (...args: unknown[]) => {
    const text = formatConsoleArgs(args);
    if (!allow.some((re) => re.test(text))) calls.push({ level, text });
  };
const guarded: Record<Level, typeof console.error> = {
  error: record('error'),
  warn: record('warn'),
};

// Idempotent: setup files run once per test file, and under isolate: false the module (and its wrappers) is shared.
export function installConsoleGuard(opts: { allow?: RegExp[] } = {}): void {
  allow = opts.allow ?? [];
  original ??= { error: console.error, warn: console.warn };
  if (console.error !== guarded.error) console.error = guarded.error;
  if (console.warn !== guarded.warn) console.warn = guarded.warn;
}

export function uninstallConsoleGuard(): void {
  if (!original) return;
  console.error = original.error;
  console.warn = original.warn;
  original = null;
  calls.length = 0;
}

// Drains the record, then throws one error listing it. `where` names when the calls landed.
export function failOnConsoleNoise(where = 'during this test'): void {
  if (!calls.length) return;
  const drained = calls.splice(0);
  const shown = drained.slice(0, 5).map((c) => `  console.${c.level}: ${c.text.slice(0, 600)}`);
  if (drained.length > shown.length) shown.push(`  …and ${drained.length - shown.length} more`);
  throw new Error(
    `${drained.length} unexpected console call(s) ${where}. Fix the cause; a test that expects the output spies ` +
      `console with mockImplementation and asserts on it (docs/product/CONVENTIONS.md → the console guard).\n` +
      shown.join('\n'),
  );
}
