// How the BFF and the MCP edge start the day's AI pick (docs/areas/recruiting/coach.md → The AI pick). Live: an
// async (Event) invoke of the coach worker (liveInvoker.ts), so the RPC returns at once and readers poll `pending`.
// Tests: inline — the pick lands before the RPC returns, like the stub. testMode and stages without the worker:
// disabled, so the plan never says a pick is due (`ai: null`, the rules, no notice).
export interface CoachPickEvent {
  userId: string;
  day: string; // the claimed day (YYYY-MM-DD)
  claimId: string;
}
export interface CoachPickInvoker {
  enabled: boolean;
  invoke(e: CoachPickEvent): Promise<void>;
}

export function noopPickInvoker(): CoachPickInvoker {
  return { enabled: false, invoke: async () => {} };
}

export function inlinePickInvoker(run: (e: CoachPickEvent) => Promise<unknown>): CoachPickInvoker {
  return {
    enabled: true,
    invoke: async (e) => {
      await run(e);
    },
  };
}
