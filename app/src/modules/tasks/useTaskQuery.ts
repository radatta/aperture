import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { todayKey } from '@aperture/shared';
import { useSettings } from '../../data/hooks/useSettings';
import { isPlace, LENS_PRESET, resetToLens } from './query';
import type { LensId, Place, TaskQuery } from './query';

const LENSES: LensId[] = ['today', 'week', 'places', 'backlog', 'done', 'recurring', 'calibration'];
export const QUERY_KEY = 'aperture.tasks.query';
const COLLAPSE_KEY = 'aperture.tasks.collapsed';

// Storage can throw (private mode, blocked site data) — every read/write degrades to "not stored".
function read<T>(store: 'session' | 'local', key: string): T | null {
  try {
    const raw = (store === 'session' ? sessionStorage : localStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(store: 'session' | 'local', key: string, value: unknown): void {
  try {
    (store === 'session' ? sessionStorage : localStorage).setItem(key, JSON.stringify(value));
  } catch {
    // not persisted — the in-memory state still works for this visit
  }
}

export interface Stored {
  day: string;
  lens: Place;
  query: TaskQuery;
}

// Storage is outside our types — a hand-edited or older-shaped value must not crash the page. A query
// stored before a field existed (areas, 2026-11) fails here and the lens loads on its preset.
export function isStored(s: Stored | null): s is Stored {
  const q = s?.query;
  return (
    !!q &&
    typeof s.day === 'string' &&
    typeof q.text === 'string' &&
    Array.isArray(q.categories) &&
    Array.isArray(q.statuses) &&
    Array.isArray(q.areas) &&
    typeof q.due === 'string' &&
    typeof q.sort === 'string' &&
    typeof q.groupBy === 'string'
  );
}

// /tasks view state. The lens lives in the URL (?lens=, so Home can deep-link to Week; with the Places
// lens, ?place= opens one store's list; ?task= is a reminder's one-shot link); search and filters live in sessionStorage, sticky for the
// session but reset each new day; which groups are collapsed lives in localStorage.
export function useTaskQuery() {
  const [params, setParams] = useSearchParams();
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const today = todayKey(dayStartHour);
  const raw = params.get('lens') as LensId | null;
  const lens: LensId = raw && LENSES.includes(raw) ? raw : 'today';
  const place: Place = isPlace(lens) ? lens : 'today';
  // The store a Places link points at (?place=<slug> — the Shortcut's tap-through, placeLensPath).
  const focusPlace = lens === 'places' ? params.get('place') : null;
  // A reminder's tap-through (reminders.ts taskPushPath): ?task=<id> opens that task once; ?n= is the
  // notification's tag (PR 3 reads it). Both leave the URL once handled — replaced, so Back doesn't
  // reopen the task.
  const linkedTaskId = params.get('task');
  const hasLink = linkedTaskId !== null || params.has('n');
  const clearLink = useCallback(
    () =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('task');
          next.delete('n');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const [stored, setStored] = useState<Stored | null>(() => {
    const s = read<Stored>('session', QUERY_KEY);
    return isStored(s) ? s : null;
  });
  // A lens switch updates the stored query at once but the URL a beat later; for that render the
  // lenses disagree. Keep the typed text across the gap (reset only the rest), or the list flashes
  // its unsearched view between two searched ones.
  const query: TaskQuery =
    stored && stored.day === today
      ? stored.lens === place
        ? stored.query
        : resetToLens(stored.query, place)
      : LENS_PRESET[place];

  const setQuery = useCallback(
    (next: TaskQuery) => {
      const s = { day: today, lens: place, query: next };
      setStored(s);
      write('session', QUERY_KEY, s);
    },
    [today, place],
  );

  // Switching lens keeps what's typed and resets the rest to the new lens's preset.
  const setLens = useCallback(
    (next: LensId) => {
      if (isPlace(next)) {
        const s = { day: today, lens: next, query: resetToLens(query, next) };
        setStored(s);
        write('session', QUERY_KEY, s);
      }
      setParams(next === 'today' ? {} : { lens: next }, { replace: true });
    },
    [today, query, setParams],
  );

  return {
    lens,
    place,
    focusPlace,
    linkedTaskId,
    hasLink,
    clearLink,
    query,
    setQuery,
    setLens,
    today,
    dayStartHour,
  };
}

// Collapsed groups, remembered per lens:group. A group with no remembered choice takes the caller's
// default (a big list group starts collapsed, ≥ COLLAPSE_AT; Today's "Done today" always does). That
// default is taken once, the first time the group is seen, so a group doesn't snap shut as it grows.
export function useCollapsedGroups() {
  const [map, setMap] = useState<Record<string, boolean>>(
    () => read<Record<string, boolean>>('local', COLLAPSE_KEY) ?? {},
  );
  const firstSeen = useRef<Record<string, boolean>>({});
  const isCollapsed = (key: string, startCollapsed: boolean) =>
    map[key] ?? (firstSeen.current[key] ??= startCollapsed);
  const toggle = (key: string, startCollapsed: boolean) =>
    setMap((m) => {
      const next = { ...m, [key]: !isCollapsedIn(m, key, startCollapsed) };
      write('local', COLLAPSE_KEY, next);
      return next;
    });
  const isCollapsedIn = (m: Record<string, boolean>, key: string, startCollapsed: boolean) =>
    m[key] ?? firstSeen.current[key] ?? startCollapsed;
  return { isCollapsed, toggle };
}
