import type { BusyInterval } from '@aperture/shared';

// The gated external seam for Google Calendar — the exact parallel of the DDB `Writes` seam. Every
// method is account-scoped (takes the Google `sub`) so the impl uses the right refresh token. READS ARE
// GATED TOO: a testMode/smoke request gets `noopGoogle`, which reads no SSM token, makes no fetch, and
// burns no refresh token. `liveGoogle` (real fetch + SSM) is wired only in index.ts; `InMemoryGoogle`
// is the stateful fake for tests. Route handlers touch the gateway, never fetch/SSM directly.

export interface CalendarInfo {
  calendarId: string;
  summary: string;
  primary: boolean;
}
export interface AccountState {
  connected: boolean; // a refresh token exists for this account
  reconnectRequired: boolean; // token exists but the last refresh failed invalid_grant
}
export interface BusyResult {
  intervals: BusyInterval[];
  allDayCount: number;
}
export interface GoogleGateway {
  // OAuth
  buildConsentUrl(signedState: string): Promise<string>;
  exchangeCode(code: string): Promise<{ sub: string; email: string; refreshToken: string }>;
  // account/token management (SSM)
  storeRefreshToken(sub: string, refreshToken: string): Promise<void>;
  removeAccount(sub: string): Promise<void>;
  getAccountState(sub: string): Promise<AccountState>;
  // calendar reads
  listCalendars(sub: string): Promise<CalendarInfo[]>;
  listBusy(sub: string, calendarId: string, timeMinMs: number, timeMaxMs: number): Promise<BusyResult>;
  // calendar writes (only ever on events whose eventId Aperture stored — enforced by the caller)
  insertEvent(input: {
    sub: string;
    calendarId: string;
    title: string;
    startMs: number;
    endMs: number;
  }): Promise<{ eventId: string }>;
  deleteEvent(input: { sub: string; calendarId: string; eventId: string }): Promise<void>;
  // Partial update (events.patch) — only the given fields change. Throws EventGoneError when the event
  // no longer exists (deleted in Google), so the caller can drop its pointer and re-create.
  patchEvent(input: PatchEventInput): Promise<void>;
}

export interface PatchEventInput {
  sub: string;
  calendarId: string;
  eventId: string;
  title?: string;
  startMs?: number;
  endMs?: number;
}

export class EventGoneError extends Error {
  constructor(eventId: string) {
    super(`Calendar event ${eventId} no longer exists`);
    this.name = 'EventGoneError';
  }
}

// testMode/smoke: every method is inert. A smoke run of any calendar method touches nothing external —
// no SSM token read, no Google fetch, no burned refresh token. Reads return empty; writes throw so a
// real mutation is never silently believed to have happened in a write-free context.
export function noopGoogle(): GoogleGateway {
  const off = (): never => {
    throw new Error('Google side-effects are disabled in testMode');
  };
  return {
    buildConsentUrl: async () => '#google-connect-disabled-in-testmode',
    exchangeCode: async () => off(),
    storeRefreshToken: async () => off(),
    removeAccount: async () => {}, // idempotent cleanup; safe to no-op
    getAccountState: async () => ({ connected: false, reconnectRequired: false }),
    listCalendars: async () => [],
    listBusy: async () => ({ intervals: [], allDayCount: 0 }),
    insertEvent: async () => off(),
    deleteEvent: async () => off(),
    patchEvent: async () => off(),
  };
}

interface FakeAccount {
  email: string;
  refreshToken: string;
  dead: boolean; // simulates an invalid_grant token
  calendars: CalendarInfo[];
  busy: Map<string, BusyResult>; // calendarId → seeded busy
}
interface FakeEvent {
  sub: string;
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
}

// Stateful fake for tests: assert what was inserted/deleted on which account, that reads use the right
// token, and that the safety rule holds. `exchangeCode(code)` deterministically yields the account
// `{sub: code, email: <code>@example.com}` so a test drives which account connects via the code value.
export class InMemoryGoogle implements GoogleGateway {
  readonly accounts = new Map<string, FakeAccount>();
  readonly events = new Map<string, FakeEvent>(); // eventId → event (only ones we inserted)
  private seq = 0;

  // --- test helpers ---
  seedAccount(sub: string, email: string, calendars: CalendarInfo[] = []): void {
    this.accounts.set(sub, {
      email,
      refreshToken: `rt-${sub}`,
      dead: false,
      calendars,
      busy: new Map(),
    });
  }
  seedBusy(sub: string, calendarId: string, result: BusyResult): void {
    this.accounts.get(sub)!.busy.set(calendarId, result);
  }
  markDead(sub: string): void {
    this.accounts.get(sub)!.dead = true;
  }

  private mustAccount(sub: string): FakeAccount {
    const a = this.accounts.get(sub);
    if (!a) throw new Error(`No connected account: ${sub}`);
    if (a.dead) throw new Error('invalid_grant');
    return a;
  }

  async buildConsentUrl(signedState: string): Promise<string> {
    return `https://consent.example/?state=${encodeURIComponent(signedState)}`;
  }
  async exchangeCode(code: string): Promise<{ sub: string; email: string; refreshToken: string }> {
    return { sub: code, email: `${code}@example.com`, refreshToken: `rt-${code}` };
  }
  async storeRefreshToken(sub: string, refreshToken: string): Promise<void> {
    const existing = this.accounts.get(sub);
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.dead = false;
    } else {
      this.accounts.set(sub, {
        email: `${sub}@example.com`,
        refreshToken,
        dead: false,
        calendars: [
          { calendarId: `${sub}@example.com`, summary: `${sub}@example.com`, primary: true },
        ],
        busy: new Map(),
      });
    }
  }
  async removeAccount(sub: string): Promise<void> {
    this.accounts.delete(sub);
  }
  async getAccountState(sub: string): Promise<AccountState> {
    const a = this.accounts.get(sub);
    return { connected: !!a, reconnectRequired: !!a?.dead };
  }
  async listCalendars(sub: string): Promise<CalendarInfo[]> {
    return this.mustAccount(sub).calendars;
  }
  async listBusy(sub: string, calendarId: string): Promise<BusyResult> {
    return this.mustAccount(sub).busy.get(calendarId) ?? { intervals: [], allDayCount: 0 };
  }
  async insertEvent(input: {
    sub: string;
    calendarId: string;
    title: string;
    startMs: number;
    endMs: number;
  }): Promise<{ eventId: string }> {
    this.mustAccount(input.sub);
    const eventId = `evt-${++this.seq}`;
    this.events.set(eventId, { ...input });
    return { eventId };
  }
  async deleteEvent(input: { sub: string; calendarId: string; eventId: string }): Promise<void> {
    this.mustAccount(input.sub);
    const evt = this.events.get(input.eventId);
    // Safety: only ever delete an event we inserted, on the account+calendar it lives on.
    if (!evt || evt.sub !== input.sub || evt.calendarId !== input.calendarId) {
      throw new Error(`Refusing to delete unknown event: ${input.eventId}`);
    }
    this.events.delete(input.eventId);
  }
  async patchEvent(input: PatchEventInput): Promise<void> {
    this.mustAccount(input.sub);
    const evt = this.events.get(input.eventId);
    if (!evt) throw new EventGoneError(input.eventId);
    // Same safety rule as delete: only an event we inserted, where it lives.
    if (evt.sub !== input.sub || evt.calendarId !== input.calendarId)
      throw new Error(`Refusing to patch unknown event: ${input.eventId}`);
    if (input.title !== undefined) evt.title = input.title;
    if (input.startMs !== undefined) evt.startMs = input.startMs;
    if (input.endMs !== undefined) evt.endMs = input.endMs;
  }
}
