import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PomodoroSession } from '@aperture/shared';
import { todayKey } from '@aperture/shared';
import { useApi } from '../../data/api-context';
import { useSettings } from '../../data/hooks/useSettings';
import { invalidateTaskData } from '../../data/hooks/invalidate';
import { PomodoroContext } from './pomodoro-context';
import type { RunningTimer, StartFocusInput } from './pomodoro-context';
import { activeSec, isStale, remainingSec, targetSecFor } from './pomodoro';

// The timer engine (PRODUCT §4b, TECH §2.3.3). Owns ALL concurrently-running timers — you run
// several at once (parallel focus, e.g. multiple sessions), each with its own label, heartbeat, and
// countdown. Freezes accrual across pauses; on a block hitting 0 it chimes and HOLDS (no auto-break)
// so several finishing at once don't spawn a pile of break timers. On load, adopts still-running
// sessions and flags long-silent ones for keep/discard. Only `work` accrues to the task (stub side).
const HEARTBEAT_MS = 15_000;

// A short, self-contained chime — no asset, and a no-op where Web Audio is absent (tests, blocked tabs).
function chime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.06, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.4);
    osc.start();
    osc.stop(ac.currentTime + 0.4);
    osc.onended = () => ac.close();
  } catch {
    // No audio available — the visual "Done" state carries it.
  }
}

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
    setBlocks((b) => {
      if (!(id in b)) return b;
      const next = { ...b };
      delete next[id];
      return next;
    });
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
        return { session, paused, remaining, done: remaining <= 0, activeSec: activeSec(session, paused, now) };
      }),
    [sessions, pausedIds, now, targetFor],
  );

  // Adopt sessions left running: fresh ones run live, long-silent ones go to the stale prompt.
  useEffect(() => {
    let cancelled = false;
    api.listRunningSessions().then((list) => {
      if (cancelled) return;
      const t = Date.now();
      setSessions(list.filter((s) => !isStale(s, t)));
      setStale(list.filter((s) => isStale(s, t)));
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
        api.heartbeatSession(s.id).then(upsert);
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
        .then((s) => {
          invalidateTaskData(qc);
          upsert(s);
          setPausedIds((p) => withDeleted(p, s.id)); // re-focusing a dedup'd task clears any stale pause
        });
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
      .then(upsert);
  }, [api, upsert, settings]);

  const pause = useCallback(
    (id: string) => {
      api.heartbeatSession(id).then((s) => {
        upsert(s); // capture time up to the pause
        setPausedIds((p) => new Set(p).add(id));
      });
    },
    [api, upsert],
  );

  const resume = useCallback(
    (id: string) => {
      api.resumeSession(id).then((s) => {
        upsert(s); // reset the clock so the paused gap isn't credited
        setPausedIds((p) => withDeleted(p, id));
      });
    },
    [api, upsert],
  );

  // Give a done timer one more block: bump the target, clear the chime latch, and reset the clock so
  // the time spent sitting on "done" isn't credited to the new block.
  const extend = useCallback(
    (id: string) => {
      api.resumeSession(id).then((s) => {
        upsert(s);
        setChimedIds((c) => withDeleted(c, id));
        setPausedIds((p) => withDeleted(p, id));
        setBlocks((b) => ({ ...b, [id]: (b[id] ?? 1) + 1 }));
      });
    },
    [api, upsert],
  );

  const stop = useCallback(
    (id: string, status: 'completed' | 'discarded' = 'completed') =>
      api.stopSession(id, status).then(() => {
        invalidateTaskData(qc);
        remove(id);
      }),
    [api, qc, remove],
  );

  const keepStale = useCallback(
    (id: string) => {
      api.resolveStaleSession(id, 'keep').then(() => {
        invalidateTaskData(qc);
        setStale((cur) => cur.filter((s) => s.id !== id));
      });
    },
    [api, qc],
  );

  const discardStale = useCallback(
    (id: string) => {
      api
        .resolveStaleSession(id, 'discard')
        .then(() => setStale((cur) => cur.filter((s) => s.id !== id)));
    },
    [api],
  );

  const value = useMemo(
    () => ({
      timers,
      stale,
      startFocus,
      startBreak,
      pause,
      resume,
      extend,
      stop,
      keepStale,
      discardStale,
    }),
    [timers, stale, startFocus, startBreak, pause, resume, extend, stop, keepStale, discardStale],
  );

  return <PomodoroContext value={value}>{children}</PomodoroContext>;
}
