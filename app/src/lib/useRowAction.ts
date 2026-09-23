import { useState } from 'react';
import type { RefObject } from 'react';

// A list row's async action (add to today, unplan, the night "when?"): the row's buttons disable
// while it runs, a failure is caught and reported (never an unhandled rejection), and — since the
// action usually moves the row out of the list, taking the focused button with it — focus lands on
// `fallback` instead of dropping to <body>.
export function useRowAction(fallback: RefObject<HTMLElement | null>) {
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);

  async function run(id: string, action: () => Promise<unknown>) {
    setFailed(false);
    setBusy((s) => new Set(s).add(id));
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      requestAnimationFrame(() => {
        const el = document.activeElement;
        if (!el || el === document.body) fallback.current?.focus();
      });
    }
  }

  return { run, failed, isBusy: (id: string) => busy.has(id) };
}
