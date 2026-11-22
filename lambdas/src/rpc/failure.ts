// One failure → HTTP status mapping for the RPC edge (index.ts), for both paths:
//   ingest — the extension's two methods; its outbox retries 409, 429 and 5xx and keeps anything else as
//            failed (extension/README.md), so a call says which it was.
//   rpc    — everything else; the app shows a 400's message, and never sees a 429 (retry.ts retries a 429 as
//            a call that never ran, which a throttle mid-write can't promise).
// A 500's text is internals (a TypeError's, an AWS fault's — AWS text can carry ARNs and account ids), so
// it's always shown as `Internal error`; so is any AWS error's, whatever its status.
import { ShapeError } from './shape';

export type FailurePath = 'ingest' | 'rpc';

const THROTTLES = [
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
];
export const isThrottle = (err: unknown) =>
  THROTTLES.includes((err as { name?: string } | null)?.name ?? '');
const BUILTIN_FAULTS: readonly (new (...a: never[]) => Error)[] = [
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
];
export const INTERNAL_ERROR = 'Internal error';
export const AWS_REFUSED = 'Request refused';

const awsStatus = (err: unknown): number | null => {
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return meta === undefined ? null : (meta.httpStatusCode ?? 500);
};
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : '');

// The table, both paths: docs/arch/INFRA.md → 4. Compute & API → Failure statuses.
export function failureStatus(err: unknown, path: FailurePath): number {
  const message = messageOf(err);
  if (message.startsWith('Unauthorized')) return 401;
  if (message.startsWith('Unknown method')) return 404;
  if (err instanceof ShapeError) return 400; // the caller's shape: retrying never helps
  const name = (err as { name?: string } | null)?.name ?? '';
  if (path === 'ingest' && name === 'ConflictError') return 409; // a lost CAS race — the outbox retries
  if (isThrottle(err)) return path === 'ingest' ? 429 : 500;
  const aws = awsStatus(err);
  if (aws !== null) return aws >= 500 || path === 'rpc' ? 500 : 400;
  if (BUILTIN_FAULTS.some((C) => err instanceof C)) return 500; // a fault in our own code
  if (!(err instanceof Error)) return 500;
  // Our own refusals: a plain Error is the input's refusal on both paths. A custom subclass
  // (ConflictError, EventGoneError, PlaidApiError…) carries a message the app shows; the extension can't
  // tell it from a fault, so ingest retries it rather than dropping the event.
  return err.constructor === Error || path === 'rpc' ? 400 : 500;
}

// What the caller is shown: a 500's text never; an AWS refusal's text never (it names the table); every
// other failure is our own message.
export function shownMessage(err: unknown, status: number): string {
  if (status === 500) return INTERNAL_ERROR;
  if (awsStatus(err) !== null) return AWS_REFUSED;
  return messageOf(err) || 'error';
}
