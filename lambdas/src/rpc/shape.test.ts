import { describe, expect, it } from 'vitest';
import {
  ShapeError,
  arr,
  bool,
  int,
  lit,
  named,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  owned,
  record,
  str,
} from './shape';
import type { Check } from './shape';

const run =
  (c: Check<unknown>, v: unknown, path = 'x') =>
  () =>
    c.run(v, path);
const refuses = (c: Check<unknown>, v: unknown, msg: string | RegExp, path = 'x') => {
  expect(run(c, v, path)).toThrow(ShapeError);
  expect(run(c, v, path)).toThrow(msg);
};

describe('shape checks', () => {
  it('str: text up to its cap, nothing else', () => {
    const c = str(3) as Check<unknown>;
    expect(run(c, 'abc')).not.toThrow();
    expect(run(c, '')).not.toThrow();
    refuses(c, 'abcd', 'x is limited to 3 characters');
    for (const bad of [1, null, {}, [], true]) refuses(c, bad, 'x must be text');
  });

  it('num, int and bool: the JSON type, finite', () => {
    expect(run(num as Check<unknown>, 1.5)).not.toThrow();
    for (const bad of ['1', NaN, Infinity, null])
      refuses(num as Check<unknown>, bad, 'x must be a number');
    expect(run(int as Check<unknown>, 3)).not.toThrow();
    refuses(int as Check<unknown>, 1.5, 'x must be a whole number');
    expect(run(bool as Check<unknown>, false)).not.toThrow();
    for (const bad of ['false', 0, null])
      refuses(bool as Check<unknown>, bad, 'x must be true or false');
  });

  it('lit: one of its values', () => {
    const c = lit('a', 'b') as Check<unknown>;
    expect(run(c, 'b')).not.toThrow();
    refuses(c, 'c', 'x must be one of a, b');
  });

  it('nullable takes null; opt takes undefined and marks the check optional', () => {
    expect(run(nullable(str(5)) as Check<unknown>, null)).not.toThrow();
    refuses(nullable(str(5)) as Check<unknown>, undefined, 'x must be text');
    const o = opt(str(5)) as Check<unknown>;
    expect(o.optional).toBe(true);
    expect(run(o, undefined)).not.toThrow();
    refuses(o, null, 'x must be text');
  });

  it('arr: a list up to its cap, each item checked with its index', () => {
    const c = arr(int, 2) as Check<unknown>;
    expect(run(c, [1, 2])).not.toThrow();
    refuses(c, [1, 2, 3], 'x is limited to 2 items');
    refuses(c, [1, 'a'], 'x[1] must be a whole number');
    refuses(c, { 0: 1 }, 'x must be a list');
  });

  it('obj: only its keys, each checked; an undefined value is an absent key', () => {
    const c = obj<{ a: string; b?: number }>('thing', { a: str(5), b: opt(num) }) as Check<unknown>;
    expect(c.obj).toBe(true);
    expect(run(c, { a: 'x' }, '')).not.toThrow();
    expect(run(c, { a: 'x', b: undefined }, '')).not.toThrow();
    refuses(c, { a: 'x', z: 1, y: 2 }, /^Unknown thing field: z, y$/, '');
    refuses(c, {}, /^a is required$/, '');
    refuses(c, { a: undefined }, /^a is required$/, '');
    refuses(c, { a: 1 }, /^a must be text$/, '');
    for (const bad of [null, [], 'x', 1]) refuses(c, bad, /^thing must be an object$/, '');
    // Nested: the path names the field, and a not-object names the path.
    refuses(c, { a: 2 }, /^outer\.a must be text$/, 'outer');
    refuses(c, null, /^outer must be an object$/, 'outer');
  });

  it('obj refuses a parsed own __proto__ key and never reads the prototype', () => {
    const c = obj<{ a: string }>('thing', { a: str(5) }) as Check<unknown>;
    refuses(
      c,
      JSON.parse('{"a":"x","__proto__":{"polluted":true}}'),
      /Unknown thing field: __proto__/,
      '',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('obj takes a custom not-object message (the pinned patch refusals)', () => {
    const c = obj<{ a?: string }>(
      'story',
      { a: opt(str(5)) },
      'story patch must be an object',
    ) as Check<unknown>;
    refuses(c, 'title', /^story patch must be an object$/, '');
  });

  it('oneOf: the discriminant picks the variant, whose keys then apply', () => {
    const c = oneOf<unknown>('rule', 'kind', {
      a: obj<{ kind: 'a' }>('rule', { kind: lit('a') }),
      b: obj<{ kind: 'b'; n: number }>('rule', { kind: lit('b'), n: int }),
    });
    expect(run(c, { kind: 'a' }, '')).not.toThrow();
    expect(run(c, { kind: 'b', n: 2 }, '')).not.toThrow();
    refuses(c, { kind: 'c' }, /^kind must be one of a, b$/, '');
    refuses(c, { kind: 'toString' }, /^kind must be one of a, b$/, ''); // own keys only
    refuses(c, { kind: 'a', n: 1 }, /^Unknown rule field: n$/, '');
    refuses(c, { kind: 'b' }, /^n is required$/, '');
    refuses(c, 'a', /^rule must be an object$/, '');
  });

  it('record: string keys up to a cap, each value checked', () => {
    const c = record<unknown>(int, 2) as Check<unknown>;
    expect(run(c, { a: 1, b: 2 })).not.toThrow();
    refuses(c, { a: 1, b: 2, c: 3 }, 'x is limited to 2 entries');
    refuses(c, { a: 'x' }, 'x.a must be a whole number');
    refuses(c, { ['k'.repeat(65)]: 1 }, /key over 64/);
  });

  it('owned: passes anything to its normalizer, refusing only keys off its list on a plain object', () => {
    expect(run(owned('review') as Check<unknown>, 'anything')).not.toThrow();
    const c = owned('review', ['help']) as Check<unknown>;
    expect(run(c, { help: 'none' })).not.toThrow();
    expect(run(c, null)).not.toThrow(); // the normalizer's 'Review must be an object'
    refuses(c, { help: 'none', extra: 1 }, /^Unknown review field: extra$/);
  });

  it('named labels a positional check without changing it', () => {
    const c = named('title', str(2));
    expect(c.name).toBe('title');
    expect(c.optional).toBe(false);
  });
});
