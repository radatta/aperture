import { Link } from 'react-router';
import { summarizeSets } from '@aperture/shared/flux';
import { Text } from '../../components/Text';
import { useFluxSets } from '../../data/hooks/useFluxSets';
import { useFluxWeekNote } from '../../data/hooks/useFluxWeekNote';

// Flux on the night home is one line, not a card (D51) — FinanceGlance's posture: today's saved sets
// ("Flux · 2 sets rotation, 1 upper trap"), linking to History, and nothing at all on a day without any.
// The week's note (D62) rides under it in the same element, on the same days-with-sets rule.
export function FluxGlance({ today }: { today: string }) {
  const { data: sets, isError } = useFluxSets({ from: today, to: today });
  const note = useFluxWeekNote();
  // A failed read is one quiet-but-visible line, never the "no sets today" silence.
  if (isError && !sets)
    return (
      <Link to="/flux/history" className="flex items-center justify-between gap-2 px-1 text-sm">
        <Text size="sm" tone="danger">
          Flux · couldn’t load today’s sets
        </Text>
        <Text size="sm" tone="muted" aria-hidden>
          History →
        </Text>
      </Link>
    );
  if (!sets?.length) return null;
  return (
    <Link
      to="/flux/history"
      className="flex items-start justify-between gap-2 px-1 text-sm hover:text-ink"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <Text size="sm" tone="muted" tabular>
          Flux · {summarizeSets(sets)}
        </Text>
        {note.isError ? (
          <Text size="xs" tone="danger">
            Couldn’t load this week’s note
          </Text>
        ) : (
          note.data && (
            <Text size="xs" tone="muted">
              {note.data.text}
            </Text>
          )
        )}
      </span>
      <Text size="sm" tone="muted" aria-hidden>
        History →
      </Text>
    </Link>
  );
}
