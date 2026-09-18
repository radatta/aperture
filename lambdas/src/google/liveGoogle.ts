import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import type { AccountState, BusyResult, CalendarInfo, GoogleGateway } from './gateway';
import { normalizeEvents, type GcalEvent } from './normalize';

// The live gateway: real Google REST (via global fetch — Node 22) + SSM for creds and per-account
// refresh tokens. Rolled by hand rather than pulling in `googleapis` (huge): token exchange + a handful
// of REST calls, the same OAuth shape already hand-rolled for Cognito. Wired ONLY in index.ts.

const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export interface LiveGoogleConfig {
  stage: string;
  appUrl: string; // e.g. https://aperture.example — redirect_uri is <appUrl>/api/google/callback
}

interface AccessCacheEntry {
  token: string;
  expiresAtMs: number;
}

// invalid_grant (dead refresh token) is a recoverable, expected state — tagged so callers can mark the
// account reconnect-required rather than crashing the whole read.
class InvalidGrantError extends Error {
  constructor() {
    super('invalid_grant');
  }
}

export class LiveGoogle implements GoogleGateway {
  private clientCreds: { clientId: string; clientSecret: string } | null = null;
  private readonly access = new Map<string, AccessCacheEntry>();

  constructor(
    private readonly ssm: SSMClient,
    private readonly cfg: LiveGoogleConfig,
  ) {}

  private param(suffix: string): string {
    return `/aperture/${this.cfg.stage}/google/${suffix}`;
  }
  private tokenParam(sub: string): string {
    return this.param(`tokens/${sub}/refresh_token`);
  }
  private get redirectUri(): string {
    return `${this.cfg.appUrl}/api/google/callback`;
  }

  private async getParam(name: string, decrypt: boolean): Promise<string | null> {
    try {
      const res = await this.ssm.send(
        new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
      );
      return res.Parameter?.Value ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === 'ParameterNotFound') return null;
      throw err;
    }
  }

  private async getClientCreds(): Promise<{ clientId: string; clientSecret: string }> {
    if (this.clientCreds) return this.clientCreds;
    const [clientId, clientSecret] = await Promise.all([
      this.getParam(this.param('client_id'), true),
      this.getParam(this.param('client_secret'), true),
    ]);
    if (!clientId || !clientSecret) throw new Error('Google client credentials not configured');
    this.clientCreds = { clientId, clientSecret };
    return this.clientCreds;
  }

  // Exchange a refresh token for a short-lived access token, cached per account until ~1 min before
  // expiry. A dead token surfaces as InvalidGrantError.
  private async getAccessToken(sub: string): Promise<string> {
    const cached = this.access.get(sub);
    if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.token;

    const refreshToken = await this.getParam(this.tokenParam(sub), true);
    if (!refreshToken) throw new Error(`No token for account ${sub}`);
    const { clientId, clientSecret } = await this.getClientCreds();

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'invalid_grant') throw new InvalidGrantError();
      throw new Error(`Token refresh failed (${res.status})`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.access.set(sub, {
      token: json.access_token,
      expiresAtMs: Date.now() + json.expires_in * 1000,
    });
    return json.access_token;
  }

  private async api(sub: string, path: string, init?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken(sub);
    return fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
  }

  async buildConsentUrl(signedState: string): Promise<string> {
    const { clientId } = await this.getClientCreds();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent', // force a refresh_token every time
      include_granted_scopes: 'true',
      state: signedState,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{ sub: string; email: string; refreshToken: string }> {
    const { clientId, clientSecret } = await this.getClientCreds();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw new Error(`Code exchange failed (${res.status})`);
    const json = (await res.json()) as { refresh_token?: string; id_token?: string };
    if (!json.refresh_token || !json.id_token) throw new Error('No refresh token in exchange');
    // id_token came straight from Google's token endpoint over TLS — decode for sub/email, no JWKS verify.
    const claims = decodeIdToken(json.id_token);
    return { sub: claims.sub, email: claims.email, refreshToken: json.refresh_token };
  }

  async storeRefreshToken(sub: string, refreshToken: string): Promise<void> {
    await this.ssm.send(
      new PutParameterCommand({
        Name: this.tokenParam(sub),
        Value: refreshToken,
        Type: 'SecureString',
        Overwrite: true,
      }),
    );
    this.access.delete(sub);
  }

  async removeAccount(sub: string): Promise<void> {
    this.access.delete(sub);
    try {
      await this.ssm.send(new DeleteParameterCommand({ Name: this.tokenParam(sub) }));
    } catch (err) {
      if (!(err instanceof Error && err.name === 'ParameterNotFound')) throw err;
    }
  }

  async getAccountState(sub: string): Promise<AccountState> {
    const refreshToken = await this.getParam(this.tokenParam(sub), true);
    if (!refreshToken) return { connected: false, reconnectRequired: false };
    try {
      await this.getAccessToken(sub);
      return { connected: true, reconnectRequired: false };
    } catch (err) {
      if (err instanceof InvalidGrantError) return { connected: true, reconnectRequired: true };
      throw err;
    }
  }

  async listCalendars(sub: string): Promise<CalendarInfo[]> {
    const res = await this.api(sub, '/users/me/calendarList?minAccessRole=reader');
    if (!res.ok) throw new Error(`calendarList failed (${res.status})`);
    const json = (await res.json()) as {
      items?: { id: string; summary?: string; primary?: boolean }[];
    };
    return (json.items ?? []).map((c) => ({
      calendarId: c.id,
      summary: c.summary ?? c.id,
      primary: !!c.primary,
    }));
  }

  async listBusy(
    sub: string,
    calendarId: string,
    timeMinMs: number,
    timeMaxMs: number,
  ): Promise<BusyResult> {
    const items: GcalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        timeMin: new Date(timeMinMs).toISOString(),
        timeMax: new Date(timeMaxMs).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.api(sub, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      if (!res.ok) throw new Error(`events.list failed (${res.status})`);
      const json = (await res.json()) as { items?: GcalEvent[]; nextPageToken?: string };
      items.push(...(json.items ?? []));
      pageToken = json.nextPageToken;
    } while (pageToken);
    return normalizeEvents(items);
  }

  async insertEvent(input: {
    sub: string;
    calendarId: string;
    title: string;
    startMs: number;
    endMs: number;
  }): Promise<{ eventId: string }> {
    const res = await this.api(input.sub, `/calendars/${encodeURIComponent(input.calendarId)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: input.title,
        start: { dateTime: new Date(input.startMs).toISOString() },
        end: { dateTime: new Date(input.endMs).toISOString() },
      }),
    });
    if (!res.ok) throw new Error(`events.insert failed (${res.status})`);
    const json = (await res.json()) as { id: string };
    return { eventId: json.id };
  }

  async deleteEvent(input: { sub: string; calendarId: string; eventId: string }): Promise<void> {
    const res = await this.api(
      input.sub,
      `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
      { method: 'DELETE' },
    );
    // 410 Gone = already deleted; treat as success (idempotent).
    if (!res.ok && res.status !== 410 && res.status !== 404) {
      throw new Error(`events.delete failed (${res.status})`);
    }
  }
}

function decodeIdToken(idToken: string): { sub: string; email: string } {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('Malformed id_token');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub?: string;
    email?: string;
  };
  if (!claims.sub || !claims.email) throw new Error('id_token missing sub/email');
  return { sub: claims.sub, email: claims.email };
}

export function createLiveGoogle(cfg: LiveGoogleConfig): LiveGoogle {
  return new LiveGoogle(new SSMClient({}), cfg);
}
