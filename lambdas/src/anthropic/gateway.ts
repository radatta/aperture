import type { ModelOutcome, ParseCategory } from '@aperture/shared';

// The gated seam for the Claude API — quick add's parse (docs/areas/tasks/quick-add.md). Like Google and
// Plaid, READS ARE GATED: the call carries a secret and a cost, so a testMode/smoke request gets
// `noopAnthropic` (no SSM read, no fetch), tests get `FakeAnthropic`, and `createLiveAnthropic` (fetch +
// SSM) is wired only in the two Lambda entrypoints. It writes nothing, so it isn't a `writes` entry.
// It never throws: every failure is an outcome, and the caller saves the line raw.

export interface ParseRequest {
  text: string;
  today: string; // the user's day (dayStartHour), YYYY-MM-DD
  categories: readonly ParseCategory[]; // active only
  timeoutMs: number;
}

export interface AnthropicGateway {
  parseTask(req: ParseRequest): Promise<ModelOutcome>;
}

export function noopAnthropic(): AnthropicGateway {
  return {
    parseTask: async () => ({ ok: false, reason: 'unavailable', detail: 'parsing is off here' }),
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
}
