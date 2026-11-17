import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { ModelOutcome } from '@aperture/shared';
import type {
  AnthropicGateway,
  CoachPickRequest,
  FluxNoteRequest,
  SittingDraftRequest,
} from './gateway';
import {
  COACH_PICK_EFFORT,
  COACH_PICK_MAX_TOKENS,
  COACH_PICK_MODEL,
  coachPickOutputSchema,
  coachPickSystemPrompt,
  coachPickUserContent,
} from './coachPickPrompt';
import { PARSE_MODEL, parseOutputSchema, parseSystemPrompt } from './parsePrompt';
import {
  fluxNoteOutputSchema,
  fluxNoteSystemPrompt,
  fluxNoteUserContent,
  NOTE_MODEL,
} from './fluxNotePrompt';
import {
  DRAFT_MODEL,
  sittingDraftOutputSchema,
  sittingDraftSystemPrompt,
  sittingDraftUserContent,
} from './sittingReviewPrompt';

// The live Claude API gateway: one raw fetch to /v1/messages (no SDK — a single fixed POST is neither
// substantial logic nor subtle correctness, and matches the hand-rolled Google/Plaid gateways) plus the
// API key from SSM SecureString `/aperture/<stage>/anthropic/api_key`, held for the warm container.
// Wired ONLY in the Lambda entrypoints; testMode never reaches it. One attempt, no retries: a failure is
// a raw save, which is cheaper than a second wait. One JSON log line per call — never the text or key.

const API_URL = 'https://api.anthropic.com/v1/messages';

type SsmLike = Pick<SSMClient, 'send'>;

export interface LiveAnthropicConfig {
  stage: string;
  fetch?: typeof fetch;
  ssm?: SsmLike;
  log?: (line: string) => void;
}

interface MessagesResponse {
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export function createLiveAnthropic(cfg: LiveAnthropicConfig): AnthropicGateway {
  const doFetch = cfg.fetch ?? fetch;
  const ssm: SsmLike = cfg.ssm ?? new SSMClient({});
  const log = cfg.log ?? ((line: string) => console.log(line));
  const keyParam = `/aperture/${cfg.stage}/anthropic/api_key`;
  let key: string | null = null;

  async function apiKey(): Promise<string | null> {
    if (key) return key;
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: keyParam, WithDecryption: true }));
      key = res.Parameter?.Value || null;
    } catch (err) {
      if (!(err instanceof Error && err.name === 'ParameterNotFound')) throw err;
    }
    return key;
  }

  // The outcome plus what the log line needs (`meta` never leaves this module).
  type Called = ModelOutcome & {
    meta?: { status?: number; stop?: string; usage?: MessagesResponse['usage'] };
  };
  const isTimeout = (err: unknown) => ['TimeoutError', 'AbortError'].includes((err as Error).name);

  // One structured-output call: a system prompt, one user message, a JSON schema for the answer.
  interface Call {
    model: string;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens: number;
    timeoutMs: number;
    // Haiku's calls turn thinking off and run at low effort; Opus 5.5 can't turn it off (a 400), so its call omits
    // `thinking` and names its effort.
    thinking?: 'disabled' | 'omit';
    effort?: 'low' | 'medium' | 'high';
  }

  async function call(req: Call): Promise<Called> {
    let k: string | null;
    try {
      k = await apiKey();
    } catch (err) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `key read failed (${(err as Error).name})`,
      };
    }
    if (!k) return { ok: false, reason: 'unavailable', detail: 'no API key on this stage' };

    let res: Response;
    try {
      res = await doFetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': k,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.thinking === 'omit' ? {} : { thinking: { type: 'disabled' } }),
          output_config: {
            effort: req.effort ?? 'low',
            format: { type: 'json_schema', schema: req.schema },
          },
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      return isTimeout(err)
        ? { ok: false, reason: 'timeout' }
        : { ok: false, reason: 'network', detail: (err as Error).message };
    }
    // A rotated or revoked key: drop the cached one so the next call re-reads SSM, not a recycle away.
    if (res.status === 401) key = null;

    let body: MessagesResponse;
    try {
      body = (await res.json()) as MessagesResponse;
    } catch (err) {
      // The timeout signal also covers the body — a stream that stalls after the headers is a timeout.
      if (isTimeout(err)) return { ok: false, reason: 'timeout', meta: { status: res.status } };
      return {
        ok: false,
        reason: 'api',
        detail: `HTTP ${res.status}`,
        meta: { status: res.status },
      };
    }
    const meta = { status: res.status, stop: body.stop_reason, usage: body.usage };
    if (!res.ok)
      return {
        ok: false,
        reason: 'api',
        detail: `HTTP ${res.status} ${body.error?.message ?? ''}`.trim(),
        meta,
      };
    if (body.stop_reason !== 'end_turn')
      return { ok: false, reason: 'api', detail: body.stop_reason ?? 'no stop_reason', meta };
    const text = body.content?.find((b) => b.type === 'text')?.text;
    let fields: unknown;
    try {
      fields = JSON.parse(text ?? '');
    } catch {
      return { ok: false, reason: 'bad-json', meta };
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
      return { ok: false, reason: 'bad-json', meta };
    return { ok: true, fields, meta };
  }

  return {
    async parseTask(req) {
      const started = Date.now();
      const { meta, ...out } = await call({
        model: PARSE_MODEL,
        system: parseSystemPrompt(req.today, req.categories, { voice: req.voice }),
        user: req.text,
        schema: parseOutputSchema(req.categories.map((c) => c.id)),
        maxTokens: 2048,
        timeoutMs: req.timeoutMs,
      });
      // status + stop_reason tell a revoked key (401) from a rate limit (429), an overload (529), a
      // refusal or max_tokens — all `reason: 'api'` to the caller.
      log(
        JSON.stringify({
          event: 'parse_task',
          ok: out.ok,
          reason: out.ok ? undefined : out.reason,
          status: meta?.status,
          stop_reason: meta?.stop,
          ms: Date.now() - started,
          chars: req.text.length,
          input_tokens: meta?.usage?.input_tokens,
          output_tokens: meta?.usage?.output_tokens,
        }),
      );
      return out;
    },
    async fluxWeekNote(req: FluxNoteRequest) {
      const started = Date.now();
      const { meta, ...out } = await call({
        model: NOTE_MODEL,
        system: fluxNoteSystemPrompt(),
        user: fluxNoteUserContent(req.line, req.summary),
        schema: fluxNoteOutputSchema(),
        maxTokens: 256,
        timeoutMs: req.timeoutMs,
      });
      log(
        JSON.stringify({
          event: 'flux_week_note',
          ok: out.ok,
          reason: out.ok ? undefined : out.reason,
          status: meta?.status,
          stop_reason: meta?.stop,
          ms: Date.now() - started,
          sets: req.summary.totalSets,
          input_tokens: meta?.usage?.input_tokens,
          output_tokens: meta?.usage?.output_tokens,
        }),
      );
      return out;
    },
    // The user's code goes to the API (decided, recruiting doc); the log line carries counts only, never the code.
    async sittingReviewDraft(req: SittingDraftRequest) {
      const started = Date.now();
      const { meta, ...out } = await call({
        model: DRAFT_MODEL,
        system: sittingDraftSystemPrompt(),
        user: sittingDraftUserContent(req.data),
        schema: sittingDraftOutputSchema(),
        maxTokens: 512,
        timeoutMs: req.timeoutMs,
      });
      log(
        JSON.stringify({
          event: 'lc_review_draft',
          ok: out.ok,
          reason: out.ok ? undefined : out.reason,
          status: meta?.status,
          stop_reason: meta?.stop,
          ms: Date.now() - started,
          judged: req.data.judged.length,
          input_tokens: meta?.usage?.input_tokens,
          output_tokens: meta?.usage?.output_tokens,
        }),
      );
      return out;
    },
    // The user's practice history goes to the API (the same posture and data class as the review draft); the log line
    // carries counts and tokens only, never the data or the answer.
    async coachPick(req: CoachPickRequest) {
      const started = Date.now();
      const { meta, ...out } = await call({
        model: COACH_PICK_MODEL,
        system: coachPickSystemPrompt(),
        user: coachPickUserContent(req.ctx),
        schema: coachPickOutputSchema(req.ctx),
        maxTokens: COACH_PICK_MAX_TOKENS,
        timeoutMs: req.timeoutMs,
        thinking: 'omit',
        effort: COACH_PICK_EFFORT,
      });
      const ms = Date.now() - started;
      const usage =
        meta?.usage?.input_tokens !== undefined || meta?.usage?.output_tokens !== undefined
          ? { input: meta.usage.input_tokens ?? 0, output: meta.usage.output_tokens ?? 0 }
          : null;
      const refused = !out.ok && meta?.stop === 'refusal';
      log(
        JSON.stringify({
          event: 'coach_pick',
          ok: out.ok,
          reason: out.ok ? undefined : refused ? 'refusal' : out.reason,
          status: meta?.status,
          stop_reason: meta?.stop,
          ms,
          candidates: req.ctx.candidates.length,
          attempts: req.ctx.recent.length,
          input_tokens: meta?.usage?.input_tokens,
          output_tokens: meta?.usage?.output_tokens,
          model: COACH_PICK_MODEL,
        }),
      );
      const common = { model: COACH_PICK_MODEL, usage, ms };
      if (out.ok) return { ...out, ...common };
      return refused
        ? { ok: false as const, reason: 'refusal' as const, detail: 'refusal', ...common }
        : { ...out, ...common };
    },
  };
}
