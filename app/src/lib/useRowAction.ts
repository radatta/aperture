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
    const origin = document.activeElement;
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
      // The row leaves when the list re-renders, which can land a few frames after the action
      // resolves — watch the pressed control until it's gone (or clearly staying), then refocus.
      let frames = 0;
      const check = () => {
        if (!(origin instanceof HTMLElement)) return;
        const lost = !document.activeElement || document.activeElement === document.body;
        if (!origin.isConnected) {
          if (lost) fallback.current?.focus();
        } else if (frames++ < 30) requestAnimationFrame(check);
        // The row stayed (e.g. the write failed): give focus back to the re-enabled control.
        else if (lost) origin.focus();
      };
      requestAnimationFrame(check);
    }
  }

  return { run, failed, isBusy: (id: string) => busy.has(id) };
}
