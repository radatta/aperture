import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card } from '../../components/Card';
import { Text } from '../../components/Text';
import { ChevronRightIcon } from '../../components/icons';

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

// A quiet "go to the deep view" affordance — teal text + a chevron (SVG, so no tofu glyph).
export function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-0.5 text-teal">
      <Text size="xs" tone="teal">
        {children}
      </Text>
      <ChevronRightIcon size={13} />
    </Link>
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
