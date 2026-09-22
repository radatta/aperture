import { Text } from '../../components/Text';

// A quiet marker that a task is a roll rep (its title already IS the roll's name, so we don't repeat it).
// Mirrors the "on calendar" marker's tone. Null for ordinary tasks.
export function RollTag({ rollId }: { rollId: string | null }) {
  if (!rollId) return null;
  return (
    <Text size="xs" tone="teal">
      roll
    </Text>
  );
}
