import type { ReactNode } from 'react';
import { Card } from '../../components/Card';
import { Text } from '../../components/Text';

// A home slot. Title row is quiet uppercase; `aside` is an optional right-aligned action/link.
export function HomeCard({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-3">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          {title}
        </Text>
        {aside}
      </div>
      {children}
    </Card>
  );
}

// Honest placeholder for a slot whose module lands in a later phase — says what it will be and when,
// so the shell reads as intentionally-unbuilt, not broken.
export function ComingSoon({ phase, children }: { phase: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Text tone="muted" size="sm">
        {children}
      </Text>
      <Text tone="subtle" size="xs">
        Lights up in Phase {phase}
      </Text>
    </div>
  );
}
