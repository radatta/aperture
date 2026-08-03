import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PomodoroSession } from '@aperture/shared';
import { useApi } from '../../data/api-context';
import { useSettings } from '../../data/hooks/useSettings';
import { invalidateTaskData } from '../../data/hooks/invalidate';
import { PomodoroContext } from './pomodoro-context';
import { isStale, remainingSec, targetSecFor } from './pomodoro';

// The timer engine (PRODUCT §4b, TECH §2.3.3). Owns the single running session: heartbeats it while
// running, freezes accrual across pauses, auto-rolls work→break at expiry, and on load prompts
// keep/discard for a session the app was closed on. Only `work` accrues to the task (handled in the
// stub's stopSession). Pomodoro is not a route — this provider sits above the router.
const HEARTBEAT_MS = 15_000;

export function PomodoroProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings } = useSettings();

  const [session, setSession] = useState<PomodoroSession | null>(null);
  const [paused, setPaused] = useState(false);
  const [stale, setStale] = useState<PomodoroSession | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expiring = useRef(false);

  // Adopt any session left running: fresh one → resume live; long-silent one → stale prompt.
  useEffect(() => {
    let cancelled = false;
    api.findRunningSession().then((s) => {
      if (cancelled || !s) return;
      if (isStale(s, Date.now())) setStale(s);
      else {
        setSession(s);
        setPaused(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // 1s display tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Persist active time on a heartbeat while genuinely running.
  useEffect(() => {
    if (!session || paused || stale) return;
    const id = setInterval(() => {
      api.heartbeatSession(session.id).then((s) => setSession((cur) => (cur?.id === s.id ? s : cur)));
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [api, session, paused, stale]);

  const target = session ? targetSecFor(session.kind, settings) : 0;
  const remaining = session ? remainingSec(session, target, paused, now) : 0;

  // Auto-complete at expiry: work accrues then rolls into a break; break just ends.
  useEffect(() => {
    if (!session || paused || stale || remaining > 0 || expiring.current) return;
    expiring.current = true;
    const kind = session.kind;
    const id = session.id;
    (async () => {
      await api.stopSession(id, 'completed');
      invalidateTaskData(qc);
      if (kind === 'work') {
        const br = await api.startSession({ taskId: null, categoryId: null, kind: 'break' });
        setSession(br);
        setPaused(false);
      } else {
        setSession(null);
      }
      expiring.current = false;
    })();
  }, [api, qc, session, paused, stale, remaining]);

  const start = useCallback(
    (taskId: string | null) => {
      (async () => {
        if (session) await api.stopSession(session.id, 'completed'); // switching focus closes the block
        const s = await api.startSession({ taskId, categoryId: null, kind: 'work' });
        invalidateTaskData(qc);
        setSession(s);
        setPaused(false);
      })();
    },
    [api, qc, session],
  );

  const startBreak = useCallback(() => {
    (async () => {
      if (session) await api.stopSession(session.id, 'completed');
      const s = await api.startSession({ taskId: null, categoryId: null, kind: 'break' });
      setSession(s);
      setPaused(false);
    })();
  }, [api, session]);

  const pause = useCallback(() => {
    if (!session) return;
    api.heartbeatSession(session.id).then((s) => {
      setSession(s); // capture time up to the pause
      setPaused(true);
    });
  }, [api, session]);

  const resume = useCallback(() => {
    if (!session) return;
    api.resumeSession(session.id).then((s) => {
      setSession(s); // reset the clock so the paused gap isn't credited
      setPaused(false);
    });
  }, [api, session]);

  const stop = useCallback(
    (status: 'completed' | 'discarded') => {
      if (!session) return;
      const id = session.id;
      api.stopSession(id, status).then(() => {
        invalidateTaskData(qc);
        setSession(null);
        setPaused(false);
      });
    },
    [api, qc, session],
  );

  const keepStale = useCallback(() => {
    if (!stale) return;
    api.resolveStaleSession(stale.id, 'keep').then(() => {
      invalidateTaskData(qc);
      setStale(null);
    });
  }, [api, qc, stale]);

  const discardStale = useCallback(() => {
    if (!stale) return;
    api.resolveStaleSession(stale.id, 'discard').then(() => setStale(null));
  }, [api, stale]);

  const value = useMemo(
    () => ({
      session,
      paused,
      stale,
      remaining,
      start,
      startBreak,
      pause,
      resume,
      stop,
      keepStale,
      discardStale,
    }),
    [session, paused, stale, remaining, start, startBreak, pause, resume, stop, keepStale, discardStale],
  );

  return <PomodoroContext value={value}>{children}</PomodoroContext>;
}
