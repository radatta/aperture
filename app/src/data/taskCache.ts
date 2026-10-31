import type { QueryClient } from '@tanstack/react-query';
import { partsOf } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { qk } from './queryKeys';

// The tasks list as the app knows it: the server's read (eventually consistent, not retried), patched
// with what our own writes returned. updatedAt is the server's last-write-wins clock on both sides, so
// "newer wins" is server against server — a stale read never overwrites a copy a write just handed
// back, and another device's later write still does. The one module that knows the list's shape.

// How long a write is remembered against stale reads. Eventual consistency closes in well under a
// second, so this only matters for a lost write or a remote delete: then a minute of the old row, and
// it heals itself.
export const LOCAL_WRITE_TTL_MS = 60_000;

type Local = { at: number; task: Task | null }; // null: deleted here
const recent = new WeakMap<QueryClient, Map<string, Local>>();
const recentFor = (qc: QueryClient) => {
  let m = recent.get(qc);
  if (!m) recent.set(qc, (m = new Map()));
  return m;
};

const sortList = (ts: Task[]) => [...ts].sort((a, b) => b.createdAt - a.createdAt);

// The server's list merged with recent local writes. An entry the server has caught up on (same or
// newer copy) is pruned, as is anything past the TTL.
export function mergeTasks(server: Task[], local: Map<string, Local>, now: number): Task[] {
  const byId = new Map(server.map((t) => [t.id, t]));
  for (const [id, e] of local) {
    if (now - e.at > LOCAL_WRITE_TTL_MS) {
      local.delete(id);
      continue;
    }
    const s = byId.get(id);
    if (e.task === null) byId.delete(id);
    else if (!s) byId.set(id, e.task);
    else if (e.task.updatedAt > s.updatedAt) byId.set(id, e.task);
    else local.delete(id);
  }
  return sortList([...byId.values()]);
}

// A loaded list with writes applied: a put replaces its id unless the cached copy is newer, or inserts;
// removes drop. No list loaded stays no list — a one-row list would paint across every view.
export function applyWrites(
  list: Task[] | undefined,
  put: Task[],
  remove: string[],
): Task[] | undefined {
  if (!list) return list;
  const byId = new Map(list.map((t) => [t.id, t]));
  for (const t of put) {
    const cached = byId.get(t.id);
    if (!cached || t.updatedAt >= cached.updatedAt) byId.set(t.id, t);
  }
  for (const id of remove) byId.delete(id);
  return sortList([...byId.values()]);
}

// What a write returned goes into the list now. The caller still invalidates: a write can change rows
// it doesn't return (a parent's lock, a dropped parent's parts, plan rows, the day's sweep).
export async function putTasks(qc: QueryClient, tasks: Task[]): Promise<void> {
  await qc.cancelQueries({ queryKey: qk.tasks() });
  const mem = recentFor(qc);
  for (const t of tasks) mem.set(t.id, { at: Date.now(), task: t });
  qc.setQueryData<Task[]>(qk.tasks(), (list) => applyWrites(list, tasks, []));
}

// A delete takes its parts with it (the server tombstones them too).
export async function removeTask(qc: QueryClient, id: string): Promise<void> {
  const ids = [id, ...partsOf(qc.getQueryData<Task[]>(qk.tasks()) ?? [], id).map((p) => p.id)];
  await qc.cancelQueries({ queryKey: qk.tasks() });
  const mem = recentFor(qc);
  for (const i of ids) mem.set(i, { at: Date.now(), task: null });
  qc.setQueryData<Task[]>(qk.tasks(), (list) => applyWrites(list, [], ids));
}

export const mergeServerList = (qc: QueryClient, server: Task[]): Task[] =>
  mergeTasks(server, recentFor(qc), Date.now());
