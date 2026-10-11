import { useState } from 'react';
import type { RefObject } from 'react';

// A list row's async action (add to today, unplan, the night "when?"): the row's buttons disable
// while it runs, a failure is caught and reported (never an unhandled rejection), and — since the
// action usually moves the row out of the list, taking the focused button with it — focus lands on
// `fallback` instead of dropping to <body>. `explain`: the failure's own message is worth showing (a
// shared rule's refusal, like a parent's open parts) — kept as `message`.
export function useRowAction(fallback: RefObject<HTMLElement | null>) {
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<unknown>, explain = false) {
    const origin = document.activeElement;
    setFailed(false);
    setMessage(null);
    setBusy((s) => new Set(s).add(id));
    try {
      await action();
    } catch (err) {
      setFailed(true);
      if (explain && err instanceof Error) setMessage(err.message);
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

  return { run, failed, message, isBusy: (id: string) => busy.has(id) };
}
