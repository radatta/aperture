import type { ModelOutcome, ParseCategory } from '@aperture/shared';
import type { FluxWeekSummary } from '@aperture/shared/flux';
import type { SittingDraftData } from './sittingReviewPrompt';

// The gated seam for the Claude API — quick add's parse (docs/areas/tasks/quick-add.md), Flux's weekly
// note (docs/areas/flux D62) and a LeetCode sitting's review draft (docs/areas/recruiting → Review). Like Google and Plaid, READS ARE GATED: the call carries a secret and a
// cost, so a testMode/smoke request gets `noopAnthropic` (no SSM read, no fetch), tests get
// `FakeAnthropic`, and `createLiveAnthropic` (fetch + SSM) is wired only in the two Lambda entrypoints.
// It writes nothing, so it isn't a `writes` entry. It never throws: every failure is an outcome, and
// the caller saves the line raw (the parse) or keeps the deterministic line (the note).

export interface ParseRequest {
  text: string;
  today: string; // the user's day (dayStartHour), YYYY-MM-DD
  categories: readonly ParseCategory[]; // active only
  timeoutMs: number;
}

export interface FluxNoteRequest {
  line: string; // the deterministic line the note rephrases (fluxWeekLine)
  summary: FluxWeekSummary;
  timeoutMs: number;
}

export interface SittingDraftRequest {
  data: SittingDraftData; // sittingDraftData: the problem, the judged runs and submits, the two codes
  timeoutMs: number;
}

export interface AnthropicGateway {
  parseTask(req: ParseRequest): Promise<ModelOutcome>;
  // `fields` is `{ note }` on success; the backend validates it (fluxNoteText) before storing anything.
  fluxWeekNote(req: FluxNoteRequest): Promise<ModelOutcome>;
  // `fields` is `{ mistakes }` on success; the backend makes it fit (draftMistakes) and stores nothing.
  sittingReviewDraft(req: SittingDraftRequest): Promise<ModelOutcome>;
}

export function noopAnthropic(): AnthropicGateway {
  return {
    parseTask: async () => ({ ok: false, reason: 'unavailable', detail: 'parsing is off here' }),
    fluxWeekNote: async () => ({
      ok: false,
      reason: 'unavailable',
      detail: 'the model is off here',
    }),
    sittingReviewDraft: async () => ({
      ok: false,
      reason: 'unavailable',
      detail: 'the model is off here',
    }),
  };
}

// The test double: records every request; `next` is the outcome to return (or a function of the request).
export class FakeAnthropic implements AnthropicGateway {
  calls: ParseRequest[] = [];
  next: ModelOutcome | ((req: ParseRequest) => ModelOutcome) = {
    ok: false,
    reason: 'unavailable',
    detail: 'FakeAnthropic: no outcome set',
  };
  async parseTask(req: ParseRequest): Promise<ModelOutcome> {
    this.calls.push(req);
    return typeof this.next === 'function' ? this.next(req) : this.next;
  }

  noteCalls: FluxNoteRequest[] = [];
  nextNote: ModelOutcome | ((req: FluxNoteRequest) => ModelOutcome) = {
    ok: false,
    reason: 'unavailable',
    detail: 'FakeAnthropic: no note set',
  };
  async fluxWeekNote(req: FluxNoteRequest): Promise<ModelOutcome> {
    this.noteCalls.push(req);
    return typeof this.nextNote === 'function' ? this.nextNote(req) : this.nextNote;
  }

  draftCalls: SittingDraftRequest[] = [];
  nextDraft: ModelOutcome | ((req: SittingDraftRequest) => ModelOutcome) = {
    ok: false,
    reason: 'unavailable',
    detail: 'FakeAnthropic: no draft set',
  };
  async sittingReviewDraft(req: SittingDraftRequest): Promise<ModelOutcome> {
    this.draftCalls.push(req);
    return typeof this.nextDraft === 'function' ? this.nextDraft(req) : this.nextDraft;
  }
}
