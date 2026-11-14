// Hand-rolled shape checks for RPC arguments off the wire (argSpecs.ts). A check validates only — it never
// copies or rewrites — and throws ShapeError, which the edge maps to a 400 on every path (failure.ts).
// Domain meaning (enum membership a domain rule owns, day-key formats, ranges) stays with that rule: these
// checks pin the JSON type, required presence, unknown keys and sizes, so nothing reaches a handler as a
// shape it never expected and nothing is stored as sent.

export class ShapeError extends Error {
  override name = 'ShapeError';
}

// The phantom `_t` makes Check<T> invariant in T, so a spec too narrow or too wide for its TS type fails to
// compile. `optional` = undefined is accepted (an omitted key or positional arg); `obj` = an object check
// (its messages name the object, not a path); `name` labels a positional argument.
export interface Check<T> {
  readonly run: (v: unknown, path: string) => void;
  readonly optional: boolean;
  readonly obj: boolean;
  readonly name?: string;
  readonly _t?: (x: T) => T;
}

// Any check, its type erased: a tagged union's variants, a record's values.
export type AnyCheck = Omit<Check<unknown>, '_t'>;

const fail = (msg: string): never => {
  throw new ShapeError(msg);
};
const check = <T>(
  run: (v: unknown, path: string) => void,
  extra: Partial<Check<T>> = {},
): Check<T> => ({
  run,
  optional: false,
  obj: false,
  ...extra,
});
const at = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const label = (path: string): string => path || 'value';
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// A positional argument's name in its messages (`<name> must be text`, `<method>: <name> is required`).
export const named = <T>(name: string, c: Check<T>): Check<T> => ({ ...c, name });

export const str = (max: number): Check<string> =>
  check((v, p) => {
    if (typeof v !== 'string') fail(`${label(p)} must be text`);
    if ((v as string).length > max) fail(`${label(p)} is limited to ${max} characters`);
  });
// A string whose membership a domain rule checks with its own message (a bucket, an area, a tag).
export const strOf = <T extends string>(max: number): Check<T> => str(max) as unknown as Check<T>;

export const num: Check<number> = check((v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${label(p)} must be a number`);
});
export const int: Check<number> = check((v, p) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${label(p)} must be a whole number`);
});
export const bool: Check<boolean> = check((v, p) => {
  if (typeof v !== 'boolean') fail(`${label(p)} must be true or false`);
});
export const lit = <const L extends readonly (string | number | boolean)[]>(
  ...values: L
): Check<L[number]> =>
  check((v, p) => {
    if (!values.includes(v as L[number])) fail(`${label(p)} must be one of ${values.join(', ')}`);
  });

export const nullable = <T>(c: Check<T>): Check<T | null> => ({
  ...c,
  run: (v, p) => {
    if (v !== null) c.run(v, p);
  },
  _t: undefined,
});
export const opt = <T>(c: Check<T>): Check<T | undefined> => ({
  ...c,
  optional: true,
  run: (v, p) => {
    if (v !== undefined) c.run(v, p);
  },
  _t: undefined,
});

export const arr = <T>(c: Check<T>, max: number): Check<T[]> =>
  check((v, p) => {
    if (!Array.isArray(v)) fail(`${label(p)} must be a list`);
    const list = v as unknown[];
    if (list.length > max) fail(`${label(p)} is limited to ${max} items`);
    list.forEach((x, i) => c.run(x, `${label(p)}[${i}]`));
  });

// NoInfer: T comes from the caller's explicit argument or the contextual type (the spec table's entry), never
// from the fields — inferring it from them would drop which keys are optional.
type Fields<T> = { [K in keyof Required<T>]: Check<T[K]> };

// A plain object holding only its type's keys, each checked. An undefined value is an absent key (JSON drops
// it; in-process callers pass it). Unknown keys are refused by name — Object.keys sees a parsed own
// `__proto__` too. `what` names the object in its messages; `notObject` overrides that one message.
export const obj = <T>(what: string, fields: NoInfer<Fields<T>>, notObject?: string): Check<T> => {
  const known = Object.keys(fields);
  return check(
    (v, p) => {
      if (!isPlainObject(v)) fail(notObject ?? `${p || what} must be an object`);
      const o = v as Record<string, unknown>;
      const bad = Object.keys(o).filter((k) => !known.includes(k));
      if (bad.length > 0) fail(`Unknown ${what} field: ${bad.join(', ')}`);
      for (const k of known) {
        const f = (fields as Record<string, AnyCheck>)[k]!;
        const val = o[k];
        if (val === undefined) {
          if (!f.optional) fail(`${at(p, k)} is required`);
          continue;
        }
        f.run(val, at(p, k));
      }
    },
    { obj: true, name: what },
  );
};

// A tagged union: the discriminant picks the variant, whose own fields (discriminant included) then apply.
export const oneOf = <T>(what: string, key: string, variants: Record<string, AnyCheck>): Check<T> =>
  check(
    (v, p) => {
      if (!isPlainObject(v)) fail(`${p || what} must be an object`);
      const tag = (v as Record<string, unknown>)[key];
      const variant =
        typeof tag === 'string' && Object.hasOwn(variants, tag) ? variants[tag] : null;
      if (!variant) fail(`${at(p, key)} must be one of ${Object.keys(variants).join(', ')}`);
      variant!.run(v, p);
    },
    { obj: true, name: what },
  );

// A plain object of string keys (at most `max`), each value checked; key membership is the domain's.
export const record = <T>(c: AnyCheck, max: number, keyMax = 64): Check<T> =>
  check((v, p) => {
    if (!isPlainObject(v)) fail(`${label(p)} must be an object`);
    const keys = Object.keys(v as object);
    if (keys.length > max) fail(`${label(p)} is limited to ${max} entries`);
    for (const k of keys) {
      if (k.length > keyMax) fail(`${label(p)} has a key over ${keyMax} characters`);
      c.run((v as Record<string, unknown>)[k], at(label(p), k));
    }
  });

// A value whose shape a domain normalizer owns, with its own messages (normalizeSittingReview,
// parsePushInput, fluxSetError…). With `keys`, a plain object must hold only those top-level keys — what the
// normalizer reads; anything else (a non-object included) is the normalizer's to refuse.
export const owned = <T>(what: string, keys?: readonly string[]): Check<T> =>
  check((v) => {
    if (!keys || !isPlainObject(v)) return;
    const bad = Object.keys(v).filter((k) => !keys.includes(k));
    if (bad.length > 0) fail(`Unknown ${what} field: ${bad.join(', ')}`);
  });

// Escape hatch for a union the checks can't express field-for-field (a create/update pair spec'd as one
// object): the caller states the wider check stands for T.
export const as = <T>(c: AnyCheck): Check<T> => c as Check<T>;
