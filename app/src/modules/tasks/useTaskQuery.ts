import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { todayKey } from '@aperture/shared';
import { useSettings } from '../../data/hooks/useSettings';
import { COLLAPSE_AT, isPlace, LENS_PRESET, resetToLens } from './query';
import type { LensId, Place, TaskQuery } from './query';

const LENSES: LensId[] = ['today', 'week', 'backlog', 'done', 'recurring', 'calibration'];
const QUERY_KEY = 'aperture.tasks.query';
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

interface Stored {
  day: string;
  lens: Place;
  query: TaskQuery;
}

// Storage is outside our types — a hand-edited or older-shaped value must not crash the page.
function isStored(s: Stored | null): s is Stored {
  const q = s?.query;
  return (
    !!q &&
    typeof s.day === 'string' &&
    typeof q.text === 'string' &&
    Array.isArray(q.categories) &&
    Array.isArray(q.statuses) &&
    typeof q.due === 'string' &&
    typeof q.sort === 'string' &&
    typeof q.groupBy === 'string'
  );
}

// /tasks view state. The lens lives in the URL (?lens=, so Home can deep-link to Week); search and
// filters live in sessionStorage, sticky for the session but reset each new day; which groups are
// collapsed lives in localStorage.
export function useTaskQuery() {
  const [params, setParams] = useSearchParams();
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const raw = params.get('lens') as LensId | null;
  const lens: LensId = raw && LENSES.includes(raw) ? raw : 'today';
  const place: Place = isPlace(lens) ? lens : 'today';

  const [stored, setStored] = useState<Stored | null>(() => {
    const s = read<Stored>('session', QUERY_KEY);
    return isStored(s) ? s : null;
  });
  const query: TaskQuery =
    stored && stored.day === today && stored.lens === place ? stored.query : LENS_PRESET[place];

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

  return { lens, place, query, setQuery, setLens, today };
}

// Collapsed groups, remembered per lens:group. A group with no remembered choice starts collapsed
// only when it's big (≥ COLLAPSE_AT) — a short group hides nothing worth hiding. That default is
// taken once, the first time the group is seen, so a group doesn't snap shut as it grows past 8.
export function useCollapsedGroups() {
  const [map, setMap] = useState<Record<string, boolean>>(
    () => read<Record<string, boolean>>('local', COLLAPSE_KEY) ?? {},
  );
  const firstSeen = useRef<Record<string, boolean>>({});
  const isCollapsed = (key: string, size: number) =>
    map[key] ?? (firstSeen.current[key] ??= size >= COLLAPSE_AT);
  const toggle = (key: string, size: number) =>
    setMap((m) => {
      const next = { ...m, [key]: !isCollapsedIn(m, key, size) };
      write('local', COLLAPSE_KEY, next);
      return next;
    });
  const isCollapsedIn = (m: Record<string, boolean>, key: string, size: number) =>
    m[key] ?? firstSeen.current[key] ?? size >= COLLAPSE_AT;
  return { isCollapsed, toggle };
}
