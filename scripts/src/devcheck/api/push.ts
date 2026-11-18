// The dev check’s BFF client (api.ts), push: scoped capture tokens, capture, push devices and reminder toggles.
// Its internals come from core.ts under the names the bodies use.
import { AUTH_HEADER, assertDevOrigin, targetOrigin } from '../config';
import { DevcheckError } from '../errors';
import { pendingIds } from '../ledger';
import {
  CAPTURE_VIA,
  type Core,
  type DevPushDevice,
  type DevPushStatus,
  type DevReminderSettings,
  type DevScopedToken,
  type DevSubscribePushInput,
  type HarnessPushSlot,
  PUSH_SUB_VIA,
  REMINDERS_ON,
  REMINDER_SETTING_KEYS,
  SCOPED_TOKEN_VIA,
  bffError,
  harnessPushEndpoint,
  harnessPushId,
  isHarnessPushId,
  ledgerKind,
} from './core';

export function pushReads(c: Core) {
  const { call } = c;
  const reads = {
    // The test user's live capture tokens, oldest first — `capture` is the only scope.
    listScopedTokens: () => call<DevScopedToken[]>('listScopedTokens', ['capture']),
    // Devices (never their endpoint or keys), the removed list, and the poller's health line.
    getPushStatus: () => call<DevPushStatus>('getPushStatus', []),
  };
  return reads;
}

export function pushWrites(c: Core) {
  const { fetch, token, ledger, run, backoff, call, assertLedger, recordToggles, capturedIds } = c;
  const writes = {
    // A capture token, ledgered like a place — intent, then the id the mint answered with (never the token,
    // whose plaintext comes back once and lives in the step's memory only). A refusal (the name rules, the
    // 5-token limit) resolves the intent as `refused` and throws with the BFF's error, for a step to read.
    async mintScopedToken(name: string): Promise<{ token: string; info: DevScopedToken }> {
      const url = `${targetOrigin()}/api/mintScopedToken`;
      assertDevOrigin(url);
      ledger.append({ run, op: 'intent', via: SCOPED_TOKEN_VIA, title: name });
      const { status, text } = await backoff(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
          body: JSON.stringify({ args: ['capture', name] }),
        }),
      );
      if (status === 200) {
        const minted = JSON.parse(text) as { token: string; info: DevScopedToken };
        ledger.append({
          run,
          op: 'created',
          id: minted.info.id,
          via: SCOPED_TOKEN_VIA,
          title: name,
        });
        return minted;
      }
      // Only a 4xx is a refusal before any write; a 5xx may have landed, so its intent stays open.
      if (status >= 400 && status < 500)
        ledger.append({ run, op: 'refused', via: SCOPED_TOKEN_VIA, title: name });
      throw new Error(`mintScopedToken → HTTP ${status}: ${text.slice(0, 200)}`);
    },
    async revokeScopedToken(id: string): Promise<void> {
      assertLedger(id, 'scopedToken');
      await call<null>('revokeScopedToken', [id]);
    },
    // The voice Shortcut's route, raw (capture.md → The route): POST /api/capture with `token` in the BFF
    // header — a capture token, 'jwt' for the test user's session (it must be refused), or none — and `body`
    // as JSON (a string goes as sent: malformed on purpose). Returns the status and parsed body, whatever they
    // are. Every POST to the route itself is ledgered like a create, whatever the bearer (a JWT or a revoked
    // token wrongly let through would still make a task): an intent, then the 200's `id` as a task
    // (CAPTURE_VIA) when it's new — so cleanup deletes it — or `refused` (a refusal, or a duplicate naming a
    // recorded task); a 5xx leaves the intent open, a possible leak. `tag` goes on the ledger title, so
    // same-text calls (the cap's 200) can't resolve each other's intents. `path` is the capture route's (a
    // wrong /api/capture… path proves its 422) or /api/listTasks (a read: a capture token must open nothing
    // else); `method` proves the 405. A 429 carrying the route's own `{error, say}` is the daily cap, returned
    // as is; any other is Lambda throttling, backed off like call()'s.
    async captureRaw(
      bearer: string | null,
      body: string | object,
      opts: { method?: 'POST' | 'GET' | 'PUT'; path?: string; tag?: string } = {},
    ): Promise<{ status: number; body: unknown }> {
      const path = opts.path ?? '/api/capture';
      if (!/^\/api\/capture(\/|$)/.test(path) && path !== '/api/listTasks')
        throw new Error(`captureRaw only reaches the capture route or /api/listTasks, not ${path}`);
      const url = `${targetOrigin()}${path}`;
      assertDevOrigin(url);
      const method = opts.method ?? 'POST';
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const text0 =
        typeof body === 'string' ? body : String((body as { text?: unknown }).text ?? '');
      const title = `${text0.slice(0, 80)}${opts.tag ? ` ${opts.tag}` : ''}`;
      const creates = method === 'POST' && path === '/api/capture';
      if (creates) ledger.append({ run, op: 'intent', via: CAPTURE_VIA, title });
      const send = () => {
        const headers: Record<string, string> = {};
        if (method !== 'GET') headers['content-type'] = 'application/json';
        if (bearer !== null) headers[AUTH_HEADER] = `Bearer ${bearer === 'jwt' ? token() : bearer}`;
        return fetch(url, {
          method,
          headers,
          ...(method === 'GET' ? {} : { body: raw }),
          redirect: 'error',
        });
      };
      const { status, text } = await backoff(send, (s, t) => s === 429 && !bffError(t));
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text.slice(0, 200);
      }
      if (creates) {
        const id = (parsed as { id?: unknown } | null)?.id;
        if (status === 200 && typeof id === 'string' && !capturedIds.has(id) && !ledger.has(id)) {
          ledger.append({ run, op: 'created', id, via: CAPTURE_VIA, title });
          capturedIds.add(id);
        } else if (status === 200 || (status >= 400 && status < 500))
          // `refused` here means "nothing new to clean": a refusal, or a duplicate naming a recorded task.
          ledger.append({ run, op: 'refused', via: CAPTURE_VIA, title });
        // A 5xx may have created the task: its intent stays open, reported as a possible leak.
      }
      return { status, body: parsed };
    },
    // Reminders. A subscribe is ledgered like createTask — intent, then the server's id — so cleanup removes
    // the device by id; a device the poller already dropped (a 404/410 from the push service) reads as gone.
    async subscribePush(input: DevSubscribePushInput): Promise<DevPushDevice> {
      ledger.append({ run, op: 'intent', via: PUSH_SUB_VIA, title: input.label });
      const device = await call<DevPushDevice>('subscribePush', [input]);
      ledger.append({ run, op: 'created', id: device.id, via: PUSH_SUB_VIA, title: input.label });
      return device;
    },
    // A harness slot's device: its id is known before the call (harnessPushId), so `created` is recorded
    // first — a response lost after the BFF wrote it still leaves cleanup the id to remove. The server must
    // answer with that id (the derivation is pinned in api.test.ts and backend.push.test.ts).
    async subscribeHarnessPush(
      slot: HarnessPushSlot,
      keys: DevSubscribePushInput['keys'],
      label: string,
    ): Promise<DevPushDevice> {
      const id = harnessPushId(slot);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: PUSH_SUB_VIA, title: label });
      const device = await call<DevPushDevice>('subscribePush', [
        { endpoint: harnessPushEndpoint(slot), keys, label },
      ]);
      if (device.id !== id)
        throw new Error(
          `slot ${slot} subscribed as ${device.id}, not ${id} — the id derivation moved`,
        );
      return device;
    },
    // The SSRF row: a subscribe the BFF must refuse (HTTP 400), so nothing is ledgered first — an intent
    // with no create would read as a leak. Answers the refusal's message. Should it land after all, its id
    // is recorded (cleanup removes it) and the call throws.
    async subscribePushExpectingRefusal(input: DevSubscribePushInput): Promise<string> {
      const url = `${targetOrigin()}/api/subscribePush`;
      assertDevOrigin(url);
      const { status, text } = await backoff(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
          body: JSON.stringify({ args: [input] }),
        }),
      );
      if (status === 200) {
        const id = (JSON.parse(text) as { id?: unknown }).id;
        if (typeof id === 'string')
          ledger.append({ run, op: 'created', id, via: PUSH_SUB_VIA, title: input.label });
        throw new Error(`subscribePush accepted ${input.endpoint} — it should have refused`);
      }
      if (status !== 400 || !bffError(text))
        throw new Error(`subscribePush → HTTP ${status}: ${text.slice(0, 200)}`);
      return (JSON.parse(text) as { error: string }).error;
    },
    // A harness device still live with no pending ledger entry (a run killed between the subscribe and its
    // record, or a ledger lost): adopted by its fixed-slot id — recorded first, so cleanup knows it — then
    // removed. Any id that isn't a harness slot's is refused.
    async removeHarnessStray(id: string, label: string): Promise<void> {
      if (!isHarnessPushId(id))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to remove device ${id} — not one of the harness's fixed endpoints`,
        );
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: PUSH_SUB_VIA, title: `stray ${label}` });
      await call<null>('unsubscribePush', [id]);
    },
    async unsubscribePush(id: string): Promise<void> {
      assertLedger(id, 'pushsub');
      await call<null>('unsubscribePush', [id]);
    },
    // Queues a test on the test user's devices — all of them this harness's (the test user has no phone).
    sendTestPush: () => call<null>('sendTestPush', []),
    // Only the three reminder toggles, recorded before the write (`reminder-toggles:<run>`) so cleanup
    // switches them back on whatever happens; cleanup's own restore goes through here too.
    async setReminderSettings(patch: DevReminderSettings): Promise<void> {
      for (const k of Object.keys(patch))
        if (!REMINDER_SETTING_KEYS.has(k))
          throw new DevcheckError(
            'LEDGER_GUARD',
            `refusing to write setting ${k} — reminder toggles only`,
          );
      recordToggles();
      await call<unknown>('updateSettings', [patch]);
    },
    // The ledger half alone, for a Settings toggle click: called before it. Writes nothing to dev.
    recordReminderToggles: (): void => recordToggles(),
    // Cleanup's restore (this run's or a swept older one's): all three on, recording nothing new — a sweep
    // must not open a `reminder-toggles:<this run>` it never flipped. Only while some run's flip is pending.
    async restoreReminderToggles(): Promise<void> {
      const entries = ledger.read();
      if (!pendingIds(entries).some((id) => ledgerKind(entries, id) === 'reminderToggles'))
        throw new DevcheckError(
          'LEDGER_GUARD',
          'refusing to restore the reminder toggles — no run recorded flipping them',
        );
      await call<unknown>('updateSettings', [{ ...REMINDERS_ON }]);
    },
  };
  return writes;
}
