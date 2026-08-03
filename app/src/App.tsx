import { useState } from 'react';
import { useTheme } from './components/theme-context';
import { Text } from './components/Text';
import { Card } from './components/Card';
import { Button } from './components/Button';
import { Field } from './components/Field';
import { ModeToggle } from './components/ModeToggle';
import { StatPair } from './components/StatPair';
import { MiniBar } from './components/MiniBar';
import { TimerPill } from './components/TimerPill';
import type { Theme } from './styles/theme';

// Temporary styleguide — the visible proof of the Phase 2 foundation. Replaced by real pages in
// Phase 3+. Kept intentionally simple: every element is a token-driven primitive.
type CaptureMode = 'log' | 'task' | 'idea';

const SWATCHES: Array<{ name: string; bg: string }> = [
  { name: 'surface', bg: 'bg-surface' },
  { name: 'panel', bg: 'bg-panel' },
  { name: 'panel-2', bg: 'bg-panel-2' },
  { name: 'teal', bg: 'bg-teal' },
  { name: 'gold', bg: 'bg-gold' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <Text tone="subtle" size="xs" weight="medium">
        {title}
      </Text>
      {children}
    </section>
  );
}

export default function App() {
  const { theme, resolved, setTheme } = useTheme();
  const [captureMode, setCaptureMode] = useState<CaptureMode>('log');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-5 py-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <Text as="h1" size="2xl" weight="semibold">
            Aperture
          </Text>
          <Text as="p" tone="muted" size="sm">
            design system · painting {resolved}
          </Text>
        </div>
        <ModeToggle<Theme>
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={theme}
          onChange={setTheme}
        />
      </header>

      <Section title="PALETTE">
        <div className="flex flex-wrap gap-3">
          {SWATCHES.map((s) => (
            <div key={s.name} className="flex flex-col items-center gap-1">
              <div className={`${s.bg} h-12 w-12 rounded-xl border border-line`} />
              <Text size="xs" tone="muted">
                {s.name}
              </Text>
            </div>
          ))}
        </div>
      </Section>

      <Section title="TYPE">
        <Card className="flex flex-col gap-1">
          <Text as="h2" size="3xl" weight="semibold">
            Less stress, honest scoping
          </Text>
          <Text tone="muted">A quiet, modern, field-notebook calm — not another loud dashboard.</Text>
          <Text tone="subtle" size="sm">
            Secondary detail sits back until you look for it.
          </Text>
        </Card>
      </Section>

      <Section title="CONTROLS">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="gold">Gold</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
        <ModeToggle<CaptureMode>
          options={[
            { value: 'log', label: 'Log' },
            { value: 'task', label: 'Task' },
            { value: 'idea', label: 'Idea' },
          ]}
          value={captureMode}
          onChange={setCaptureMode}
        />
        <Field label="Capture" placeholder="What happened?" />
      </Section>

      <Section title="DATA">
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Text size="sm" tone="muted">
              Estimate vs actual
            </Text>
            <StatPair estimateMin={60} actualMin={78} />
          </div>
          <div className="flex flex-col gap-2">
            <Text size="sm" tone="muted">
              Planned 4h into a 6h day
            </Text>
            <MiniBar plannedMin={240} availableMin={360} />
            <Text size="sm" tone="muted">
              Planned 11h into a 6h day
            </Text>
            <MiniBar plannedMin={660} availableMin={360} />
          </div>
          <div className="flex flex-wrap gap-3">
            <TimerPill seconds={1500} running label="Deep Work" />
            <TimerPill seconds={0} />
          </div>
        </Card>
      </Section>
    </div>
  );
}
