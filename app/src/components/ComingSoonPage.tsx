import { Text } from './Text';

// Honest deep-view shell: names the page and the phase that fills it in. Home = glance works today;
// these are the "work" surfaces still to be built.
export function ComingSoonPage({
  title,
  blurb,
  phase,
}: {
  title: string;
  blurb: string;
  phase: number;
}) {
  return (
    <div className="flex flex-col gap-2 py-6">
      <Text as="h1" size="2xl" weight="semibold">
        {title}
      </Text>
      <Text tone="muted">{blurb}</Text>
      <Text tone="muted" size="sm">
        Lights up in Phase {phase}.
      </Text>
    </div>
  );
}
