import { Link } from 'react-router';
import { summarizeSets } from '@aperture/shared/flux';
import { Text } from '../../components/Text';
import { useFluxSets } from '../../data/hooks/useFluxSets';

// Flux on the night home is one line, not a card (D51) — FinanceGlance's posture: today's saved sets
// ("Flux · 2 sets rotation, 1 upper trap"), linking to History, and nothing at all on a day without any.
export function FluxGlance({ today }: { today: string }) {
  const { data: sets, isError } = useFluxSets({ from: today, to: today });
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
      className="flex items-center justify-between gap-2 px-1 text-sm hover:text-ink"
    >
      <Text size="sm" tone="muted" tabular>
        Flux · {summarizeSets(sets)}
      </Text>
      <Text size="sm" tone="muted" aria-hidden>
        History →
      </Text>
    </Link>
  );
}
