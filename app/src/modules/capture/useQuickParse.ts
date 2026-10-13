import { useRef, useState } from 'react';
import type { ParseTaskResult } from '@aperture/shared';
import { useParseTask } from '../../data/hooks/useTasks';

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

  function parse(text: string): Promise<ParseTaskResult> {
    if (inflight.current?.text === text) return inflight.current.promise;
    // A transport failure is a parse failure too — the caller saves raw, and says so.
    const promise = parseTask(text).catch((e: unknown): ParseTaskResult => ({
      ok: false,
      reason: 'network',
      detail: e instanceof Error ? e.message : undefined,
    }));
    const entry = { text, promise };
    inflight.current = entry;
    void promise.then(() => {
      if (inflight.current === entry) inflight.current = null;
    });
    return promise;
  }

  function review(text: string): void {
    setPreview({ text, result: null });
    void parse(text).then((result) => setPreview((p) => (p?.text === text ? { text, result } : p)));
  }

  return {
    parse,
    review,
    previewFor: (text: string): QuickPreview | null => (preview?.text === text ? preview : null),
    clear: () => setPreview(null),
  };
}
