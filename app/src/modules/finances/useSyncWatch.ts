import { useCallback, useEffect, useRef, useState } from 'react';
import { FINANCE_SYNCING_MAX_MS } from '@aperture/shared';
import type { FinanceOverview } from '@aperture/shared';
import { useRequestFinanceSync } from '../../data/hooks/useFinances';

interface Armed {
  overview: FinanceOverview | undefined; // the overview on screen when the sync was started
  errorAt: Map<string, number | null>; // itemId → its error stamp then
}

export interface SyncFailure {
  itemId: string;
  code: string;
}

export interface SyncWatch {
  arm: () => void; // call BEFORE starting a sync you want to hear about
  disarm: () => void; // the request failed or was refused — nothing is coming
  retry: () => void; // a plain sync (not a refresh: a failed Refresh still holds the cooldown)
  retrying: boolean;
  failed: SyncFailure | null; // what the dialog shows, while it's open
  dismiss: () => void;
}

// A sync you started (Refresh, connect, reconnect) that fails pops a dialog; one that ran on its own
// schedule only shows the banner. Arming snapshots each item's error stamp and the overview on screen.
// The first NEWER overview that isn't syncing decides: an item whose error stamp changed → the
// dialog, otherwise → quietly disarm. Stamps are compared, not clocks, so client/server skew can't
// miss or fake one; "newer" is overview identity (React Query keeps it stable until data changes).
// The server marks a request `syncing` until its run stamps a success or failure, so the in-between
// polls never decide early. An arm that hears nothing within the server's own syncing cap expires.
export function useSyncWatch(overview: FinanceOverview | undefined): SyncWatch {
  const [armed, setArmed] = useState<Armed | null>(null);
  const [failed, setFailed] = useState<SyncFailure | null>(null);
  const latest = useRef(overview);
  latest.current = overview;
  const request = useRequestFinanceSync();

  const arm = useCallback(() => {
    const o = latest.current;
    setArmed({
      overview: o,
      errorAt: new Map((o?.sync.items ?? []).map((i) => [i.itemId, i.lastErrorAt])),
    });
  }, []);
  const disarm = useCallback(() => setArmed(null), []);

  useEffect(() => {
    if (!armed || !overview || overview === armed.overview || overview.sync.syncing) return;
    const hit = overview.sync.items.find(
      (i) =>
        i.lastError !== null &&
        i.lastErrorAt !== null &&
        i.lastErrorAt !== (armed.errorAt.get(i.itemId) ?? null),
    );
    setArmed(null);
    if (hit) setFailed({ itemId: hit.itemId, code: hit.lastError! });
  }, [armed, overview]);

  // Expiry runs on a timer, not on the next overview: once polling stops nothing else would come.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), FINANCE_SYNCING_MAX_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const retry = useCallback(() => {
    arm();
    request.mutate(false, {
      onSuccess: (r) => {
        if (!r.accepted) disarm();
      },
      onError: disarm,
    });
  }, [arm, disarm, request]);

  return {
    arm,
    disarm,
    retry,
    retrying: request.isPending,
    failed,
    dismiss: useCallback(() => setFailed(null), []),
  };
}
