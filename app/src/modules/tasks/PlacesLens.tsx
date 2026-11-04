import { useEffect, useId, useRef, useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button, ButtonLink } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { CheckIcon } from '../../components/icons';
import { useRowAction } from '../../lib/useRowAction';
import { usePlaces } from '../../data/hooks/usePlaces';
import { useCheckOffErrand, useCreateTask } from '../../data/hooks/useTasks';
import { CategoryTag } from './CategoryTag';
import { GroupHeader } from './GroupHeader';
import { TaskCard } from './TaskCard';
import { TaskTitleButton } from './TaskTitleButton';
import { COLLAPSE_AT, foldParts, placer } from './query';
import type { QueryCtx } from './query';
import { useOpenTask } from './task-modal-context';
import { useCollapsedGroups } from './useTaskQuery';

// How long "Add again" stays offered after a check-off: done is terminal, so a mis-tap is undone by a copy.
const RECEIPT_MS = 4000;

interface Group {
  slug: string;
  name: string;
  tasks: Task[];
}

// The Places lens: the errands waiting on each store's list (query.ts placeOf's 'places' bucket), one group
// per place in the order you added them (Settings › Places), each list oldest first — the order the
// Shortcut's notification reads. One tap checks an errand off (started then finished: no actual, never a
// calibration point), with a few seconds to Add it again. `focus` is the store a link named (?place=,
// the Shortcut's tap-through): its group opens and scrolls into view.
export function PlacesLens({
  tasks,
  ctx,
  focus,
  pending,
  error,
  onRetry,
}: {
  tasks: Task[];
  ctx: QueryCtx;
  focus: string | null;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const placesQ = usePlaces();
  const roster = placesQ.data;
  // Without the roster the lists still show, headed by their link word — the line above says why.
  const rosterFailed = placesQ.isError && roster === undefined;
  const checkOff = useCheckOffErrand();
  const again = useCreateTask();
  const collapsed = useCollapsedGroups();
  const listRef = useRef<HTMLDivElement>(null);
  const action = useRowAction(listRef);
  const idBase = useId();
  // `at` is a nonce, so a second check-off re-arms the timer.
  const [receipt, setReceipt] = useState<{
    task: Task;
    at: number;
    failed?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!receipt || receipt.failed) return;
    const id = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(id);
  }, [receipt]);

  const place = placer(tasks, ctx);
  const errands = foldParts(tasks.filter((t) => place(t) === 'places')).sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  const known = roster ?? [];
  const knownSlugs = new Set(known.map((p) => p.slug));
  const groups: Group[] = known.map((p) => ({
    slug: p.slug,
    name: p.name,
    tasks: errands.filter((t) => t.place === p.slug),
  }));
  // A slug the roster doesn't hold (it failed, or a stale cache) still gets its list.
  for (const slug of new Set(errands.map((t) => t.place!).filter((s) => !knownSlugs.has(s))))
    groups.push({ slug, name: `@${slug}`, tasks: errands.filter((t) => t.place === slug) });
  // An emptied list stays while its receipt does (Add again lands back in it), and the linked one always.
  const shown = groups.filter(
    (g) => g.tasks.length > 0 || g.slug === focus || g.slug === receipt?.task.place,
  );
  const unknownFocus = !!focus && roster !== undefined && !groups.some((g) => g.slug === focus);
  const groupId = (slug: string) => `${idBase}-${slug}`;

  // Bring the linked list into view once it's drawn — once per link, not on every refetch.
  const scrolled = useRef<string | null>(null);
  const focusShown = !!focus && shown.some((g) => g.slug === focus);
  useEffect(() => {
    if (!focus || !focusShown || scrolled.current === focus) return;
    scrolled.current = focus;
    document.getElementById(groupId(focus))?.scrollIntoView?.({ block: 'start' });
  });

  function check(task: Task) {
    void action.run(task.id, async () => {
      const done = await checkOff.mutateAsync(task);
      setReceipt({ task: done, at: Date.now() });
    });
  }
  async function addAgain(task: Task) {
    try {
      await again.mutateAsync({ title: task.title, place: task.place });
      setReceipt(null);
    } catch {
      setReceipt({ task, at: Date.now(), failed: true }); // stays until dismissed by the next action
    }
  }

  const rosterError = rosterFailed && (
    <LoadError onRetry={() => void placesQ.refetch()}>
      Couldn’t load your places — lists show by their link word.
    </LoadError>
  );
  const waiting = pending || (placesQ.isPending && !rosterFailed);

  if (waiting || error || (shown.length === 0 && !unknownFocus))
    return (
      <div ref={listRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        {rosterError}
        {roster !== undefined && known.length === 0 && !waiting && !error ? (
          <EmptyState
            title="No places yet."
            action={
              <ButtonLink to="/settings" size="sm">
                Open Settings
              </ButtonLink>
            }
          >
            Add a store in Settings › Places, then put errands on its list from the bar below: a
            title, then “ | @” and the store’s link word.
          </EmptyState>
        ) : (
          <EmptyState pending={waiting} error={error} onRetry={onRetry} title="No errands.">
            {known[0]
              ? `Put one on a list from the bar below — “milk | @${known[0].slug}”.`
              : 'Put one on a list from the bar below: a title, then “ | @” and the store’s link word.'}
          </EmptyState>
        )}
      </div>
    );

  return (
    <div ref={listRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      {rosterError}
      <div role="status">
        {action.failed && (
          <Text size="sm" tone="danger">
            Couldn’t check that off — try again.
          </Text>
        )}
      </div>
      {unknownFocus && (
        <Text size="sm" tone="gold">
          No place “{focus}” — it may have been renamed or deleted in Settings › Places.
        </Text>
      )}
      {shown.map((g) => {
        const key = `places:${g.slug}`;
        const big = g.tasks.length >= COLLAPSE_AT;
        const linked = g.slug === focus;
        const isOpen = linked || !collapsed.isCollapsed(key, big);
        return (
          <section
            key={g.slug}
            id={groupId(g.slug)}
            aria-label={g.name}
            className="flex scroll-mt-4 flex-col gap-2"
          >
            <GroupHeader
              label={g.name}
              count={g.tasks.length}
              isOpen={isOpen}
              // The linked list stays open: it's the one you came for.
              onToggle={linked ? undefined : () => collapsed.toggle(key, big)}
            />
            {isOpen && g.tasks.length === 0 && (
              <Text size="sm" tone="muted">
                Nothing on this list.
              </Text>
            )}
            {isOpen &&
              g.tasks.map((t) =>
                tasks.some((x) => x.parentId === t.id) ? (
                  <TaskCard key={t.id} task={t} showParts />
                ) : (
                  <ErrandRow
                    key={t.id}
                    task={t}
                    busy={action.isBusy(t.id)}
                    onCheck={() => check(t)}
                  />
                ),
              )}
            {receipt?.task.place === g.slug && (
              <Receipt
                task={receipt.task}
                failed={!!receipt.failed}
                busy={again.isPending}
                onAddAgain={() => void addAgain(receipt.task)}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

// One errand: a thumb-sized check (44px) and the title, which opens the editor like any task row.
function ErrandRow({ task, busy, onCheck }: { task: Task; busy: boolean; onCheck: () => void }) {
  const openTask = useOpenTask();
  const titleRef = useRef<HTMLButtonElement>(null);
  return (
    <Card className="flex items-center gap-1 py-1 pl-1 pr-3.5">
      <button
        type="button"
        aria-label={`Check off ${task.title}`}
        disabled={busy}
        onClick={onCheck}
        className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-teal disabled:opacity-50"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-current">
          <CheckIcon size={13} className="opacity-0 transition group-hover:opacity-100" />
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5">
        <TaskTitleButton
          task={task}
          ref={titleRef}
          onOpen={() => openTask?.(task, 'view', titleRef.current)}
        />
        <div className="flex flex-wrap items-center gap-x-2">
          <CategoryTag categoryId={task.categoryId} />
        </div>
      </div>
    </Card>
  );
}

function Receipt({
  task,
  failed,
  busy,
  onAddAgain,
}: {
  task: Task;
  failed: boolean;
  busy: boolean;
  onAddAgain: () => void;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 pl-3">
      <Text size="sm" tone={failed ? 'danger' : 'teal'}>
        {failed ? `Couldn’t add “${task.title}” back — try again.` : `Checked off “${task.title}”.`}
      </Text>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onAddAgain}>
        Add again
      </Button>
    </div>
  );
}
