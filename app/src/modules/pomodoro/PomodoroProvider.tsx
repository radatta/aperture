import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PomodoroSession } from '@aperture/shared';
import { todayKey } from '@aperture/shared';
import { useApi } from '../../data/api-context';
import { useSettings } from '../../data/hooks/useSettings';
import { invalidateTaskData } from '../../data/hooks/invalidate';
import { qk } from '../../data/queryKeys';
import { PomodoroContext } from './pomodoro-context';
import type { RunningTimer, StartFocusInput } from './pomodoro-context';
import { activeSec, isStale, remainingSec, targetSecFor } from './pomodoro';
import { chime, unlockAudio } from './chime';

// The timer engine (PRODUCT §4b, TECH §2.3.3). Owns ALL concurrently-running timers — you run
// several at once (parallel focus, e.g. multiple sessions), each with its own label, heartbeat, and
// countdown. Freezes accrual across pauses; on a block hitting 0 it chimes and HOLDS (no auto-break)
// so several finishing at once don't spawn a pile of break timers. On load, adopts still-running
// sessions and flags long-silent ones for keep/discard. Only `work` accrues to the task (stub side).
const HEARTBEAT_MS = 15_000;
const MISSED_BEATS_WARN = 2; // ≥30 s unheard — well inside STALE_MS, so it warns before the server caps time

const without = <T,>(rec: Record<string, T>, id: string) => {
  if (!(id in rec)) return rec;
  const next = { ...rec };
  delete next[id];
  return next;
};

const withDeleted = (set: Set<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export function PomodoroProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings } = useSettings();

  const [sessions, setSessions] = useState<PomodoroSession[]>([]);
  const [pausedIds, setPausedIds] = useState<Set<string>>(() => new Set());
  const [blocks, setBlocks] = useState<Record<string, number>>({}); // target multiplier per timer (extend)
  const [chimedIds, setChimedIds] = useState<Set<string>>(() => new Set());
  const [stale, setStale] = useState<PomodoroSession[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [errors, setErrors] = useState<Record<string, string>>({}); // per timer or stale session
  const [missed, setMissed] = useState<Record<string, number>>({}); // consecutive failed heartbeats
  const [adoptFailed, setAdoptFailed] = useState(false);
  const [adoptTry, setAdoptTry] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const fail = useCallback((id: string, msg: string) => setErrors((e) => ({ ...e, [id]: msg })), []);
  const clear = useCallback((id: string) => setErrors((e) => without(e, id)), []);

  const upsert = useCallback(
    (s: PomodoroSession) =>
      setSessions((cur) =>
        cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s],
      ),
    [],
  );
  const remove = useCallback((id: string) => {
    setSessions((cur) => cur.filter((x) => x.id !== id));
    setPausedIds((p) => withDeleted(p, id));
    setChimedIds((c) => withDeleted(c, id));
    setBlocks((b) => without(b, id));
    setErrors((e) => without(e, id));
    setMissed((m) => without(m, id));
  }, []);

  const targetFor = useCallback(
    (s: PomodoroSession) => targetSecFor(s.kind, settings) * (blocks[s.id] ?? 1),
    [settings, blocks],
  );

  // Derived per-timer display state.
  const timers: RunningTimer[] = useMemo(
    () =>
      sessions.map((session) => {
        const paused = pausedIds.has(session.id);
        const remaining = remainingSec(session, targetFor(session), paused, now);
        return {
          session,
          paused,
          remaining,
          done: remaining <= 0,
          activeSec: activeSec(session, paused, now),
          error: errors[session.id] ?? null,
          syncFailed: (missed[session.id] ?? 0) >= MISSED_BEATS_WARN,
        };
      }),
    [sessions, pausedIds, now, targetFor, errors, missed],
  );

  // Adopt sessions left running: fresh ones run live, long-silent ones go to the stale prompt.
  // Through the query client so it gets the read retry policy; a failure says so in the dock (adoptFailed),
  // never an empty dock that reads as "nothing running".
  useEffect(() => {
    let cancelled = false;
    qc.fetchQuery({
      queryKey: qk.runningSessions(),
      queryFn: () => api.listRunningSessions(),
      staleTime: 0,
      gcTime: 0,
    }).then(
      (list) => {
        if (cancelled) return;
        const t = Date.now();
        setAdoptFailed(false);
        // Merged, not replaced: a timer started while this read had failed survives its Retry.
        setSessions((cur) => [
          ...cur.filter((c) => !list.some((s) => s.id === c.id)),
          ...list.filter((s) => !isStale(s, t)),
        ]);
        setStale(list.filter((s) => isStale(s, t)));
      },
      () => {
        if (!cancelled) setAdoptFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, qc, adoptTry]);
  const retryAdopt = useCallback(() => setAdoptTry((n) => n + 1), []);

  // Any click or keypress unlocks audio (capture, so a stopPropagation can't swallow it). A timer adopted
  // on load chimes only if it finishes after the first interaction.
  useEffect(() => {
    window.addEventListener('click', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);
    return () => {
      window.removeEventListener('click', unlockAudio, true);
      window.removeEventListener('keydown', unlockAudio, true);
    };
  }, []);

  // 1s display tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Keep a live snapshot for the heartbeat loop so the interval itself stays stable (no reset per beat).
  const beatRef = useRef({ sessions, pausedIds, targetFor });
  beatRef.current = { sessions, pausedIds, targetFor };

  // One heartbeat loop beats every timer that's genuinely running (not paused, not done).
  useEffect(() => {
    const id = setInterval(() => {
      const { sessions: live, pausedIds: paused, targetFor: tf } = beatRef.current;
      const t = Date.now();
      for (const s of live) {
        if (paused.has(s.id)) continue;
        if (remainingSec(s, tf(s), false, t) <= 0) continue; // done → frozen
        api.heartbeatSession(s.id).then(
          (next) => {
            upsert(next);
            setMissed((m) => without(m, s.id));
          },
          () => setMissed((m) => ({ ...m, [s.id]: (m[s.id] ?? 0) + 1 })),
        );
      }
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [api, upsert]);

  // Chime once when a timer first reaches 0. Keyed on the set of done ids so it fires per transition.
  const doneKey = timers
    .filter((t) => t.done)
    .map((t) => t.session.id)
    .join(',');
  useEffect(() => {
    const doneIds = doneKey ? doneKey.split(',') : [];
    const fresh = doneIds.filter((id) => !chimedIds.has(id));
    if (fresh.length === 0) return;
    chime();
    setChimedIds((c) => new Set([...c, ...fresh]));
  }, [doneKey, chimedIds]);

  const startFocus = useCallback(
    (input?: StartFocusInput) => {
      api
        .startSession({
          taskId: input?.taskId ?? null,
          categoryId: null,
          kind: 'work',
          label: input?.label ?? null,
          day: todayKey(settings?.dayStartHour ?? 4), // client owns "today"; server is UTC
        })
        .then(
          (s) => {
            setStartError(null);
            invalidateTaskData(qc);
            upsert(s);
            setPausedIds((p) => withDeleted(p, s.id)); // re-focusing a dedup'd task clears any stale pause
          },
          () => setStartError('Couldn’t start the timer — try again.'),
        );
    },
    [api, qc, upsert, settings],
  );

  const startBreak = useCallback(() => {
    api
      .startSession({
        taskId: null,
        categoryId: null,
        kind: 'break',
        label: null,
        day: todayKey(settings?.dayStartHour ?? 4), // client owns "today"; server is UTC
      })
      .then(
        (s) => {
          setStartError(null);
          upsert(s);
        },
        () => setStartError('Couldn’t start the break — try again.'),
      );
  }, [api, upsert, settings]);

  const pause = useCallback(
    (id: string) => {
      // The pause holds locally either way — you asked for it. A failed capture beat costs at most one
      // heartbeat of credit, and the row says it isn't syncing.
      setPausedIds((p) => new Set(p).add(id));
      api.heartbeatSession(id).then(
        (s) => {
          upsert(s); // capture time up to the pause
          setMissed((m) => without(m, id));
        },
        () => setMissed((m) => ({ ...m, [id]: MISSED_BEATS_WARN })),
      );
    },
    [api, upsert],
  );

  const resume = useCallback(
    (id: string) => {
      // Never flips to running locally on a failure: the server's clock wasn't reset, so the gap would count.
      api.resumeSession(id).then(
        (s) => {
          clear(id);
          upsert(s); // reset the clock so the paused gap isn't credited
          setPausedIds((p) => withDeleted(p, id));
        },
        () => fail(id, 'Couldn’t resume — try again.'),
      );
    },
    [api, upsert, clear, fail],
  );

  // Give a done timer one more block: bump the target, clear the chime latch, and reset the clock so
  // the time spent sitting on "done" isn't credited to the new block.
  const extend = useCallback(
    (id: string) => {
      api.resumeSession(id).then(
        (s) => {
          clear(id);
          upsert(s);
          setChimedIds((c) => withDeleted(c, id));
          setPausedIds((p) => withDeleted(p, id));
          setBlocks((b) => ({ ...b, [id]: (b[id] ?? 1) + 1 }));
        },
        () => fail(id, 'Couldn’t extend — try again.'),
      );
    },
    [api, upsert, clear, fail],
  );

  const stop = useCallback(
    (id: string, status: 'completed' | 'discarded' = 'completed') =>
      api.stopSession(id, status).then(
        () => {
          invalidateTaskData(qc);
          remove(id);
        },
        (e: unknown) => {
          // The timer stays: a stop that didn't land never looks like it did.
          fail(id, 'Couldn’t stop — try again.');
          throw e;
        },
      ),
    [api, qc, remove, fail],
  );

  const keepStale = useCallback(
    (id: string) => {
      api.resolveStaleSession(id, 'keep').then(
        () => {
          clear(id);
          invalidateTaskData(qc);
          setStale((cur) => cur.filter((s) => s.id !== id));
        },
        () => fail(id, 'Couldn’t save — try again.'),
      );
    },
    [api, qc, clear, fail],
  );

  const discardStale = useCallback(
    (id: string) => {
      api.resolveStaleSession(id, 'discard').then(
        () => {
          clear(id);
          setStale((cur) => cur.filter((s) => s.id !== id));
        },
        () => fail(id, 'Couldn’t discard — try again.'),
      );
    },
    [api, clear, fail],
  );

  const value = useMemo(
    () => ({
      timers,
      stale,
      staleErrors: Object.fromEntries(stale.flatMap((x) => (errors[x.id] ? [[x.id, errors[x.id]!]] : []))),
      adoptFailed,
      retryAdopt,
      startError,
      startFocus,
      startBreak,
      pause,
      resume,
      extend,
      stop,
      keepStale,
      discardStale,
    }),
    [
      timers,
      stale,
      errors,
      adoptFailed,
      retryAdopt,
      startError,
      startFocus,
      startBreak,
      pause,
      resume,
      extend,
      stop,
      keepStale,
      discardStale,
    ],
  );

  return <PomodoroContext value={value}>{children}</PomodoroContext>;
}
