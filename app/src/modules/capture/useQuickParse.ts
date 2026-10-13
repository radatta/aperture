import { useCallback, useRef, useState } from 'react';
import type { ParseTaskResult } from '@aperture/shared';
import { useParseTask } from '../../data/hooks/useTasks';

// The client's own ceiling on a parse. The server's model budget is ≤ 8s (parseBudgetMs) plus its SSM and
// DynamoDB reads; past this the capture saves raw rather than waiting out the Lambda's 15s — the parse
// window is the one stretch where the capture lives only in memory (and the outbox, captureOutbox.ts).
export const PARSE_CLIENT_TIMEOUT_MS = 10_000;

// The parse, or a timeout outcome once `ms` passes with no reply (the late reply is then ignored).
export function withTimeout(p: Promise<ParseTaskResult>, ms: number): Promise<ParseTaskResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ParseTaskResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: 'timeout', detail: `no reply in ${ms / 1000}s` }),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// A Review's preview, keyed to the exact (trimmed) text it was parsed from. result null = still parsing.
export interface QuickPreview {
  text: string;
  result: ParseTaskResult | null;
}

// Quick add's parse state for the capture bar (docs/areas/tasks/quick-add.md). Two callers:
//   review(text) — parse into a visible preview (Review / ⌘Enter);
//   parse(text)  — the promise Auto (Enter) saves from; it reuses an in-flight parse of the same text,
//                  so Enter right after Review never asks the model twice.
// Staleness is by key, not by event: a preview only shows while its text equals the field's, so an edit
// hides it, and a late result for an older text lands under that older key and never shows.
export function useQuickParse() {
  const parseTask = useParseTask();
  const [preview, setPreview] = useState<QuickPreview | null>(null);
  const inflight = useRef<{ text: string; promise: Promise<ParseTaskResult> } | null>(null);

  const parse = useCallback(
    (text: string): Promise<ParseTaskResult> => {
      if (inflight.current?.text === text) return inflight.current.promise;
      // A transport failure is a parse failure too — the caller saves raw, and says so.
      const promise = withTimeout(
        parseTask(text).catch((e: unknown): ParseTaskResult => ({
          ok: false,
          reason: 'network',
          detail: e instanceof Error ? e.message : undefined,
        })),
        PARSE_CLIENT_TIMEOUT_MS,
      );
      const entry = { text, promise };
      inflight.current = entry;
      void promise.then(() => {
        if (inflight.current === entry) inflight.current = null;
      });
      return promise;
    },
    [parseTask],
  );

  const review = useCallback(
    (text: string): void => {
      setPreview({ text, result: null });
      void parse(text).then((result) =>
        setPreview((p) => (p?.text === text ? { text, result } : p)),
      );
    },
    [parse],
  );

  const clear = useCallback(() => setPreview(null), []);

  return {
    parse,
    review,
    previewFor: (text: string): QuickPreview | null => (preview?.text === text ? preview : null),
    clear,
  };
}
