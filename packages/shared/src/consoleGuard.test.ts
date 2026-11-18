import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  failOnConsoleNoise,
  formatConsoleArgs,
  installConsoleGuard,
  uninstallConsoleGuard,
} from './consoleGuard';

afterEach(() => {
  uninstallConsoleGuard();
  vi.restoreAllMocks();
});

describe('the console guard', () => {
  it('records console.error and console.warn, then fails once with both, and the record starts over', () => {
    installConsoleGuard();
    console.error('boom %s', 'here');
    console.warn(new Error('careful'));
    expect(() => failOnConsoleNoise()).toThrow(
      /2 unexpected console call\(s\) during this test[\s\S]*console\.error: boom here[\s\S]*console\.warn: Error: careful/,
    );
    expect(() => failOnConsoleNoise()).not.toThrow();
  });

  it('lets an allowlisted message through unrecorded, and only that one', () => {
    installConsoleGuard({ allow: [/^known noise/] });
    console.error('known noise, on purpose');
    expect(() => failOnConsoleNoise()).not.toThrow();
    console.error('something else');
    expect(() => failOnConsoleNoise()).toThrow(/something else/);
  });

  it('a test that expects the output spies it with mockImplementation: nothing recorded, and the guard is back after restore', () => {
    installConsoleGuard();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    console.error('expected');
    expect(spy).toHaveBeenCalledWith('expected');
    expect(() => failOnConsoleNoise()).not.toThrow();
    vi.restoreAllMocks();
    console.error('after restore');
    expect(() => failOnConsoleNoise('after the last test')).toThrow(
      /after the last test[\s\S]*after restore/,
    );
  });

  it('installing twice keeps one wrapper; uninstalling puts the real console back', () => {
    const real = console.error;
    installConsoleGuard();
    const wrapped = console.error;
    installConsoleGuard();
    expect(console.error).toBe(wrapped);
    uninstallConsoleGuard();
    expect(console.error).toBe(real);
  });

  it('caps the listing at five calls and says how many more', () => {
    installConsoleGuard();
    for (let i = 0; i < 7; i++) console.warn(`w${i}`);
    expect(() => failOnConsoleNoise()).toThrow(/7 unexpected[\s\S]*w4\n {2}…and 2 more$/);
  });
});

describe('formatConsoleArgs', () => {
  it('fills format specifiers the way console does, and appends the rest', () => {
    expect(formatConsoleArgs(['An update to %s inside a test', 'Foo', 'extra'])).toBe(
      'An update to Foo inside a test extra',
    );
    expect(formatConsoleArgs(['%c styled %d%%', 'color: red', 5])).toBe(' styled 5%');
    expect(formatConsoleArgs([{ a: 1 }, 2])).toBe('{"a":1} 2');
  });
});
