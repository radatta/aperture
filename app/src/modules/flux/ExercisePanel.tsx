import type { Axis, EvalControl, ExerciseDefinition, ExerciseState } from '@aperture/shared/flux';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CheckCircleIcon, PlayIcon, RotateIcon, WarningIcon } from '../../components/icons';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import type { Sample } from './engine/protocol';
import { HoldRing } from './HoldRing';
import { liveReadout } from './readout';

// Live, per-kind exercise feedback derived from definition + evaluator state — flux-track's panel, with
// its strings, restyled to Aperture's tokens. Aperture adds a finished state + Again to the two kinds
// that had none (romReps, holdAtTarget).

const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(0)}°`;
const start: EvalControl = { type: 'start' };

export function ExercisePanel({
  def,
  sample,
  state,
  idle = false,
  onControl,
}: {
  def: ExerciseDefinition;
  sample: Sample;
  state: ExerciseState | null;
  idle?: boolean; // camera not started: say so instead of "Getting ready…"
  onControl: (c: EvalControl) => void;
}) {
  return (
    <Card className="p-5">
      {idle && !state ? (
        <Text as="p" size="sm" tone="muted">
          Start the camera to begin.
        </Text>
      ) : (
        <Feedback def={def} sample={sample} state={state} onControl={onControl} />
      )}
      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4">
        <Text as="p" size="sm" className="leading-relaxed">
          {def.instructions}
        </Text>
        {def.cues.length > 0 && (
          <ul className="flex flex-col gap-1">
            {def.cues.map((c) => (
              <li key={c} className="flex items-start gap-2 text-xs text-ink-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-teal" />
                {c}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Feedback({
  def,
  sample,
  state,
  onControl,
}: {
  def: ExerciseDefinition;
  sample: Sample;
  state: ExerciseState | null;
  onControl: (c: EvalControl) => void;
}) {
  const live = liveReadout(def, state);
  if (def.kind === 'romReps' && state?.kind === 'romReps') {
    const total = live?.count?.of ?? def.reps;
    const mag = Math.abs(sample.rel[def.axis]);
    const pct = Math.min(100, (mag / def.targetDeg) * 100);
    const hit = mag >= def.targetDeg;
    const complete = state.phase === 'complete';
    const ring = live?.ring;
    return (
      <div>
        <Metric big={`${live?.count?.n ?? 0}`} unit={`/ ${total} reps`} done={complete} />
        {complete ? (
          <StartBlock done reps={total} onStart={() => onControl(start)} />
        ) : (
          <>
            {ring && (
              <div className="mt-4 flex justify-center">
                <HoldRing
                  {...ring}
                  sublabel={
                    state.zone !== 'neutral' ? 'hold at end range' : `${def.holdSec}s each rep`
                  }
                />
              </div>
            )}
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs text-ink-muted">
                <span>current {fmt(sample.rel[def.axis])}</span>
                <span>target {def.targetDeg}°</span>
              </div>
              <div
                role="progressbar"
                aria-label="Range toward target"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 overflow-hidden rounded-full bg-panel-2"
              >
                <div
                  className={cx(
                    'h-full rounded-full transition-[width] duration-75',
                    hit ? 'bg-gold' : 'bg-teal',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </>
        )}
        {def.direction === 'bilateral' && (
          <div className="mt-3 flex gap-3 text-center text-xs text-ink-muted">
            <SideStat label="Side A" n={state.repsPos} target={def.reps} />
            <SideStat label="Side B" n={state.repsNeg} target={def.reps} />
          </div>
        )}
        {state.compensating && !complete && (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-gold-soft px-3 py-2 text-xs font-medium text-ink">
            <WarningIcon size={14} className="shrink-0 text-gold" />
            Keep steady — move only in this plane, not tilting or nodding
          </p>
        )}
      </div>
    );
  }

  if (def.kind === 'holdAtTarget' && state?.kind === 'holdAtTarget') {
    if (state.phase === 'complete')
      return (
        <div className="flex flex-col items-center">
          <StartBlock done reps={def.reps} onStart={() => onControl(start)} />
          <Text size="sm" tone="muted">
            Hold {state.holdsDone} / {def.reps}
          </Text>
        </div>
      );
    const axes = Object.keys(def.target) as Axis[];
    const offsets = axes.map((a) => ({ axis: a, remaining: (def.target[a] ?? 0) - sample.rel[a] }));
    const aligned = offsets.every((o) => Math.abs(o.remaining) <= def.toleranceDeg);
    return (
      <div className="flex flex-col items-center">
        {live?.ring && (
          <HoldRing {...live.ring} sublabel={state.inPosition ? 'hold' : 'get in position'} />
        )}
        <Text as="p" size="sm" tone="muted" className="mt-3">
          Hold {state.holdsDone} / {def.reps}
        </Text>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {aligned ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-gold-soft px-2 py-1 text-xs font-medium text-ink">
              <CheckCircleIcon size={14} className="text-gold" /> In position — hold
            </span>
          ) : (
            offsets
              .filter((o) => Math.abs(o.remaining) > def.toleranceDeg)
              .map((o) => (
                <span key={o.axis} className="rounded-md bg-panel-2 px-2 py-1 text-xs text-ink">
                  {axisVerb(o.axis)} {o.remaining > 0 ? '▲' : '▼'}{' '}
                  {Math.abs(o.remaining).toFixed(0)}°
                </span>
              ))
          )}
        </div>
      </div>
    );
  }

  if (def.kind === 'guidedHold' && state?.kind === 'guidedHold') {
    return (
      <div className="flex flex-col items-center">
        {state.phase === 'active' && live?.ring ? (
          <>
            <HoldRing {...live.ring} />
            <Text as="p" size="sm" tone="muted" className="mt-3">
              Rep {live.count?.n} / {def.reps}
            </Text>
            {state.drifting && (
              <Text as="p" size="xs" weight="medium" tone="danger" className="mt-2">
                Keep your head still
              </Text>
            )}
          </>
        ) : (
          <StartBlock
            done={state.phase === 'complete'}
            reps={def.reps}
            onStart={() => onControl(start)}
          />
        )}
        <Text as="p" size="xs" tone="muted" className="mt-3 text-center">
          Guided — the timer runs the set; the angle isn&apos;t measured
        </Text>
      </div>
    );
  }

  if (def.kind === 'reposition' && state?.kind === 'reposition') {
    const prompt =
      state.phase !== 'active'
        ? null
        : state.sub === 'away'
          ? 'Turn your head away from neutral'
          : state.sub === 'returning'
            ? 'Now return to your neutral'
            : 'Hold still…';
    const avg = state.errorCount ? state.errorSum / state.errorCount : null;
    return (
      <div className="flex flex-col items-center">
        {state.phase === 'active' ? (
          <>
            <Metric big={`${state.trialsDone}`} unit={`/ ${def.reps} trials`} />
            <Text as="p" size="sm" tone="teal" className="mt-2">
              {prompt}
            </Text>
            {avg !== null && (
              <Text as="p" size="xs" tone="muted" className="mt-1">
                avg error {avg.toFixed(1)}°
              </Text>
            )}
          </>
        ) : (
          <StartBlock
            done={state.phase === 'complete'}
            reps={def.reps}
            onStart={() => onControl(start)}
            avgError={avg}
          />
        )}
      </div>
    );
  }

  if (def.kind === 'oscillation' && state?.kind === 'oscillation') {
    return (
      <div className="flex flex-col items-center">
        {state.phase === 'active' && live?.ring ? (
          <>
            <HoldRing {...live.ring} />
            <Text as="p" size="sm" tone="muted" className="mt-3">
              {Math.floor(state.cycles)} cycles · ~{state.amplitudeEwma.toFixed(0)}° swing
            </Text>
          </>
        ) : (
          <StartBlock
            done={state.phase === 'complete'}
            reps={0}
            label={`${def.durationSec}s`}
            onStart={() => onControl(start)}
          />
        )}
      </div>
    );
  }

  return (
    <Text as="p" size="sm" tone="muted">
      Getting ready…
    </Text>
  );
}

function Metric({ big, unit, done }: { big: string; unit: string; done?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cx('text-5xl font-semibold tabular-nums', done ? 'text-gold' : 'text-ink')}>
        {big}
      </span>
      <Text size="sm" tone="muted">
        {unit}
      </Text>
      {done && <CheckCircleIcon size={20} className="text-gold" />}
    </div>
  );
}

function SideStat({ label, n, target }: { label: string; n: number; target: number }) {
  return (
    <div className="flex-1 rounded-lg bg-panel-2 py-2">
      <div className="text-lg font-semibold text-ink tabular-nums">
        {n}
        <span className="text-xs text-ink-muted">/{target}</span>
      </div>
      <div className="text-[11px] tracking-wide uppercase">{label}</div>
    </div>
  );
}

function StartBlock({
  done,
  reps,
  label,
  avgError,
  onStart,
}: {
  done: boolean;
  reps: number;
  label?: string;
  avgError?: number | null;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      {done ? (
        <div className="flex flex-col items-center gap-1">
          <CheckCircleIcon size={40} className="text-gold" />
          <Text as="p" size="sm" weight="medium" tone="gold">
            Set complete
          </Text>
          {avgError != null && (
            <Text as="p" size="xs" tone="muted">
              avg error {avgError.toFixed(1)}°
            </Text>
          )}
        </div>
      ) : (
        <Text as="p" size="sm" tone="muted">
          {reps > 0 ? `${reps} reps` : label} · get into position, then start
        </Text>
      )}
      <Button onClick={onStart} className="gap-2 px-5">
        {done ? <RotateIcon /> : <PlayIcon />}
        {done ? 'Again' : 'Start'}
      </Button>
    </div>
  );
}

function axisVerb(axis: Axis): string {
  if (axis === 'pitch') return 'Nod';
  if (axis === 'yaw') return 'Turn';
  return 'Tilt';
}
