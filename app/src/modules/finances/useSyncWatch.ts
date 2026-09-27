import { useCallback, useEffect, useRef, useState } from 'react';
import { FINANCE_SYNCING_MAX_MS } from '@aperture/shared';
import type { FinanceOverview } from '@aperture/shared';
import { useRequestFinanceSync } from '../../data/hooks/useFinances';
import { nowMs } from './ago';

interface Armed {
  errorAt: number | null;
  syncedAt: number | null;
  at: number; // client clock — only to give up on a run that never reported back
}

export interface SyncWatch {
  arm: () => void; // call BEFORE starting a sync you want to hear about
  disarm: () => void; // the request failed or was refused — nothing is coming
  retry: () => void; // a plain sync (not a refresh: a failed Refresh still holds the cooldown)
  failed: string | null; // the error code to show, while the dialog is open
  dismiss: () => void;
}

// A sync you started (Refresh, connect, reconnect) that fails pops a dialog; one that ran on its own
// schedule only shows the banner. Arming snapshots the overview's error and last-synced stamps; the
// next overview that isn't syncing decides it: a different error stamp → the dialog, a newer success
// → quietly disarm. Stamps are compared, not clocks, so client/server skew can't miss or fake one.
export function useSyncWatch(overview: FinanceOverview | undefined): SyncWatch {
  const [armed, setArmed] = useState<Armed | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef(overview);
  latest.current = overview;
  const request = useRequestFinanceSync();

  const arm = useCallback(() => {
    const s = latest.current?.sync;
    setArmed({ errorAt: s?.lastErrorAt ?? null, syncedAt: s?.lastSyncedAt ?? null, at: nowMs() });
  }, []);
  const disarm = useCallback(() => setArmed(null), []);

  const sync = overview?.sync;
  useEffect(() => {
    if (!armed || !sync || sync.syncing) return;
    if (sync.lastError && sync.lastErrorAt !== null && sync.lastErrorAt !== armed.errorAt) {
      setFailed(sync.lastError);
      setArmed(null);
    } else if (sync.lastSyncedAt !== armed.syncedAt) setArmed(null);
    // A run that never reported back (a lost invoke) — stop waiting, so a later scheduled failure
    // can't pop this dialog hours afterwards.
    else if (nowMs() - armed.at > FINANCE_SYNCING_MAX_MS) setArmed(null);
  }, [armed, sync]);

  const retry = useCallback(() => {
    arm();
    request.mutate(false, {
      onSuccess: (r) => {
        if (!r.accepted) disarm();
      },
      onError: disarm,
    });
  }, [arm, disarm, request]);

  return { arm, disarm, retry, failed, dismiss: useCallback(() => setFailed(null), []) };
}
