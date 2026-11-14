import { usePlaces } from '../../data/hooks/usePlaces';

// The errand list a task is on, as "@Grocer" — the name resolves live from the places roster (a rename
// propagates), the task stores the slug. No place renders nothing. A failed roster read marks the gap
// (the "—" pill, CategoryTag's rule); a slug the roster doesn't know reads as the slug itself.
export function PlaceTag({ place }: { place: string | null }) {
  const { data: places, isError } = usePlaces();
  if (!place) return null;
  if (isError && !places)
    return (
      <span
        title="Couldn’t load places"
        role="img"
        aria-label="Place unknown — couldn’t load places"
        className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-subtle"
      >
        —
      </span>
    );
  if (!places) return null;
  const name = places.find((p) => p.slug === place)?.name ?? place;
  return (
    <span
      title={`On the ${name} list`}
      className="max-w-full truncate rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted"
    >
      @{name}
    </span>
  );
}
