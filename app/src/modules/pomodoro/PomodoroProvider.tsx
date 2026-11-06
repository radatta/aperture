import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PomodoroSession } from '@aperture/shared';
import { todayKey } from '@aperture/shared';
import { useApi } from '../../data/api-context';
import { useSettings } from '../../data/hooks/useSettings';
import { invalidateTaskData } from '../../data/hooks/invalidate';
import { isNotFound } from '../../data/retry';
import { qk } from '../../data/queryKeys';
import { PomodoroContext } from './pomodoro-context';
import type { RunningTimer, StartFocusInput } from './pomodoro-context';
import { isStale, remainingSec, stopCapMin, targetSecFor, workedSec } from './pomodoro';
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
  const [chimedIds, setChimedIds] = useState<Set<string>>(() => new Set());
  const [stale, setStale] = useState<PomodoroSession[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [errors, setErrors] = useState<Record<string, string>>({}); // per timer or stale session
  const [missed, setMissed] = useState<Record<string, number>>({}); // consecutive failed heartbeats
  const [adoptFailed, setAdoptFailed] = useState(false);
  const [adoptTry, setAdoptTry] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const fail = useCallback(
    (id: string, msg: string) => setErrors((e) => ({ ...e, [id]: msg })),
    [],
  );
  const clear = useCallback((id: string) => setErrors((e) => without(e, id)), []);

  // A heartbeat or resume answered after its timer was stopped must not bring the row back.
  const stopped = useRef(new Set<string>());
  const upsert = useCallback(
    (s: PomodoroSession) =>
      !stopped.current.has(s.id) &&
      setSessions((cur) =>
        cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s],
      ),
    [],
  );
  const remove = useCallback((id: string) => {
    stopped.current.add(id);
    setSessions((cur) => cur.filter((x) => x.id !== id));
    setPausedIds((p) => withDeleted(p, id));
    setChimedIds((c) => withDeleted(c, id));
    setErrors((e) => without(e, id));
    setMissed((m) => without(m, id));
  }, []);

  const targetFor = useCallback(
    (s: PomodoroSession) => targetSecFor(s.kind, settings) * (s.blocks ?? 1),
    [settings],
  );

  // Derived per-timer display state.
  const timers: RunningTimer[] = useMemo(
    () =>
      sessions.map((session) => {
        const paused = pausedIds.has(session.id);
        // Until the settings load the target is only the default: never Done on it (a longer real block
        // would stop beating, and its stop would be capped short), and the count isn't held at it.
        const known = settings !== undefined;
        const target = targetFor(session);
        const remaining = remainingSec(session, target, paused, now);
        return {
          session,
          paused,
          remaining,
          done: known && remaining <= 0,
          activeSec: workedSec(session, known ? target : Infinity, paused, now),
          error: errors[session.id] ?? null,
          syncFailed: (missed[session.id] ?? 0) >= MISSED_BEATS_WARN,
        };
      }),
    [sessions, pausedIds, now, targetFor, settings, errors, missed],
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
          ...list.filter((s) => !isStale(s, t) && !stopped.current.has(s.id)),
        ]);
        setStale(list.filter((s) => isStale(s, t) && !stopped.current.has(s.id)));
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
  const beatRef = useRef({ sessions, pausedIds, targetFor, timers, settings });
  beatRef.current = { sessions, pausedIds, targetFor, timers, settings };

  // One heartbeat loop beats every timer that's genuinely running (not paused, not done).
  useEffect(() => {
    const id = setInterval(() => {
      const { sessions: live, pausedIds: paused, targetFor: tf, settings: known } = beatRef.current;
      const t = Date.now();
      for (const s of live) {
        if (paused.has(s.id)) continue;
        if (known && remainingSec(s, tf(s), false, t) <= 0) continue; // done → frozen
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
    (input?: StartFocusInput): Promise<boolean> => {
      setStartError(null);
      return api
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
            void invalidateTaskData(qc);
            upsert(s);
            setPausedIds((p) => withDeleted(p, s.id)); // re-focusing a dedup'd task clears any stale pause
            return true;
          },
          () => {
            setStartError('Couldn’t start the timer — try again.');
            return false;
          },
        );
    },
    [api, qc, upsert, settings],
  );

  const startBreak = useCallback(() => {
    setStartError(null);
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
      // The pause holds locally either way — you asked for it. If the capture beat fails, the time since
      // the last beat that did land isn't credited (Resume resets the server's clock), and the row says
      // it isn't syncing.
      clear(id);
      setPausedIds((p) => new Set(p).add(id));
      api.heartbeatSession(id).then(
        (s) => {
          upsert(s); // capture time up to the pause
          setMissed((m) => without(m, id));
        },
        () => setMissed((m) => ({ ...m, [id]: MISSED_BEATS_WARN })),
      );
    },
    [api, upsert, clear],
  );

  const resume = useCallback(
    (id: string) => {
      // Never flips to running locally on a failure: the server's clock wasn't reset, so the gap would count.
      clear(id);
      api.resumeSession(id).then(
        (s) => {
          setMissed((m) => without(m, id));
          upsert(s); // reset the clock so the paused gap isn't credited
          setPausedIds((p) => withDeleted(p, id));
        },
        () => fail(id, 'Couldn’t resume — try again.'),
      );
    },
    [api, upsert, clear, fail],
  );

  // Give a done timer one more block: the server credits the block's last stretch up to its target (the
  // same cap as a stop, so the wait isn't credited and a locked phone's stretch isn't lost), raises the
  // target on the row and restarts the clock; here, the chime latch clears.
  const extending = useRef(new Set<string>()); // a second tap before the answer must not add a second block
  const extend = useCallback(
    (id: string) => {
      if (extending.current.has(id)) return;
      extending.current.add(id);
      clear(id);
      const { timers: live, targetFor: tf } = beatRef.current;
      const timer = live.find((t) => t.session.id === id);
      const capMin = timer ? stopCapMin(timer, tf(timer.session)) : undefined;
      api
        .extendSession(id, capMin === undefined ? undefined : { capMin })
        .then(
          (s) => {
            setMissed((m) => without(m, id));
            upsert(s);
            setChimedIds((c) => withDeleted(c, id));
            setPausedIds((p) => withDeleted(p, id));
          },
          () => fail(id, 'Couldn’t extend — try again.'),
        )
        .finally(() => extending.current.delete(id));
    },
    [api, upsert, clear, fail],
  );

  // The server credits everything since the last beat on a stop, capped at what may still be real work
  // (stopCapMin): a paused timer 0 — its pause beat captured the worked time, so the pause never counts; a
  // timer on "done" what was left to its target — the wait before Stop isn't work, while a block that ended
  // behind a locked phone (iOS freezes a hidden page's timers, so it never beat after the lock) keeps its
  // last stretch, which a client-side reset would have dropped (PR 83). A running timer stops uncapped.
  // Not found means the server has no running row by that id: the stop already landed (its response was
  // lost, or another device stopped it), so it's settled here too — Mark done waits on this, and a row stuck
  // on "Couldn't stop" would hold it until a reload re-adopted. The task's accrual is re-read either way.
  const stop = useCallback(
    (id: string, status: 'completed' | 'discarded' = 'completed') => {
      clear(id);
      const { timers: live, targetFor: tf } = beatRef.current;
      const timer = live.find((t) => t.session.id === id);
      const capMin =
        status === 'completed' && timer ? stopCapMin(timer, tf(timer.session)) : undefined;
      const settled = () => {
        void invalidateTaskData(qc);
        remove(id);
      };
      return api
        .stopSession(id, status, capMin === undefined ? undefined : { capMin })
        .then(settled, (e: unknown) => {
          if (isNotFound(e)) return settled();
          // The timer stays: a stop that didn't land never looks like it did.
          fail(id, 'Couldn’t stop — try again.');
          throw e;
        });
    },
    [api, qc, remove, fail, clear],
  );

  const keepStale = useCallback(
    (id: string) => {
      clear(id);
      api.resolveStaleSession(id, 'keep').then(
        () => {
          void invalidateTaskData(qc);
          setStale((cur) => cur.filter((s) => s.id !== id));
        },
        () => fail(id, 'Couldn’t save — try again.'),
      );
    },
    [api, qc, clear, fail],
  );

  const discardStale = useCallback(
    (id: string) => {
      clear(id);
      api.resolveStaleSession(id, 'discard').then(
        () => {
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
      staleErrors: Object.fromEntries(
        stale.flatMap((x) => (errors[x.id] ? [[x.id, errors[x.id]!]] : [])),
      ),
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
