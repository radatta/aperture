import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  contraindicationFor,
  getExercise,
  isExerciseId,
  sideLabel,
  type ExerciseDefinition,
  type ExerciseId,
} from '@aperture/shared/flux';
import { dayKey, ulid } from '@aperture/shared';
import { Button, ButtonLink } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ArrowLeftIcon } from '../../components/icons';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { CameraStage } from '../../modules/flux/CameraStage';
import { DebugReadout } from '../../modules/flux/DebugReadout';
import { hasSide, mirrorForSide, type Side } from '../../modules/flux/engine/side';
import { ExercisePanel } from '../../modules/flux/ExercisePanel';
import { EndRangeBadge, MeasurementBadge } from '../../modules/flux/ExerciseLibrary';
import { PrecautionBanner } from '../../modules/flux/PrecautionBanner';
import { readCondition } from '../../modules/flux/prefs';
import { RepTieStrip } from '../../modules/flux/RepTie';
import { SetsStepper } from '../../modules/flux/SetsStepper';
import { useRepTie } from '../../modules/flux/useRepTie';
import { draftToInput } from '../../modules/flux/fluxOutbox';
import { UnsavedSetsStrip } from '../../modules/flux/UnsavedSetsStrip';
import { useFluxOutbox } from '../../modules/flux/useFluxOutbox';
import { DEFAULT_SETS, useFluxEngine, type SessionSummary } from '../../modules/flux/useFluxEngine';
import { useVoice } from '../../modules/flux/useVoice';

// /flux/:exerciseId — one exercise's stage. Keyed by id, so moving between exercises is a fresh stage
// (camera stopped, contraindication re-gated), as Back → pick did in flux-track.
export function FluxExerciseView() {
  const { exerciseId = '' } = useParams();
  if (!isExerciseId(exerciseId))
    return (
      <EmptyState
        title="No such exercise."
        action={
          <ButtonLink to="/flux" size="sm">
            All exercises
          </ButtonLink>
        }
      >
        The link may be from an older version of Flux.
      </EmptyState>
    );
  return <Stage key={exerciseId} id={exerciseId} />;
}

function Stage({ id }: { id: ExerciseId }) {
  const def = getExercise(id);
  const [condition] = useState(readCondition);
  const contra = contraindicationFor(def, condition);
  const [acked, setAcked] = useState(false);
  const acknowledged = !contra || acked;
  const sided = hasSide(def);
  const [side, setSide] = useState<Side>('a');
  const shown = mirrorForSide(def, side);
  const [sets, setSets] = useState(DEFAULT_SETS);
  const lastSide = useRef<Side>('a'); // the side the last finished set was done on

  const voice = useVoice();
  const rep = useRepTie();
  const outbox = useFluxOutbox();
  // A finished session — by Stop, or by itself after the last set (D42) — offers the Roll tie.
  const finish = (session: SessionSummary) => {
    if (session.sets > 0) void rep.onStop(session.activeMs);
  };
  const engine = useFluxEngine({
    exerciseId: id,
    kind: def.kind,
    side: sided ? side : null,
    condition,
    acknowledged,
    voice,
    sets,
    // Every set with anything in it is saved — finished (D47) or ended early (D55) — through the outbox
    // so a dropped connection can't lose it (D49).
    onSetCompleted: (set) => {
      if (!set.stoppedEarly && set.side) lastSide.current = set.side;
      const repTaskId = rep.onSetCompleted();
      const keys = { id: ulid(), day: dayKey(set.completedAt, rep.dayStartHour), repTaskId };
      void outbox.save(draftToInput(set, keys));
    },
    // A sided stretch alternates: the next set is the other side from the last *finished* set, so neither
    // a toggle during the rest nor a side switched mid-set (D55) does the same side twice.
    onNextSet: () => sided && setSide(other(lastSide.current)),
    onSessionEnd: finish,
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const start = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas) void engine.start({ video, canvas });
  };

  const stop = () => finish(engine.stop());

  const live = engine.status === 'running';

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/flux"
        onClick={engine.stop}
        className="inline-flex items-center gap-1.5 self-start text-sm text-ink-muted transition hover:text-ink"
      >
        <ArrowLeftIcon /> All exercises
      </Link>

      <CameraStage
        def={shown}
        engine={engine}
        voice={voice}
        videoRef={videoRef}
        canvasRef={canvasRef}
        onStart={start}
        onStop={stop}
        startAccessory={<SetsStepper value={sets} onChange={setSets} />}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Text as="h2" size="lg" weight="semibold">
            {def.name}
          </Text>
          <MeasurementBadge ex={def} />
          {def.provocative && <EndRangeBadge />}
        </div>
        {voice.on && voice.voices.length > 0 && (
          <Select
            aria-label="Voice"
            title="Pick the voice (previews on change)"
            placeholder="Auto voice"
            value={voice.name ?? ''}
            onChange={(e) => voice.change(e.target.value || null)}
            options={voice.voices.map((v) => ({ value: v.name, label: v.name }))}
            className="max-w-[10rem] py-1 text-xs"
          />
        )}
      </div>

      {sided && <SideToggle def={def} side={side} onChange={setSide} />}

      <PrecautionBanner
        precautions={def.precautions}
        contraindication={contra}
        acknowledged={acknowledged}
        onAcknowledge={() => setAcked(true)}
      />

      {live && !engine.calibrated && (
        <p className="rounded-lg bg-teal-soft px-3 py-2 text-xs text-ink">
          Look straight ahead and hold still — your neutral sets itself in a couple of seconds, or
          tap <b>Calibrate neutral</b>.
        </p>
      )}
      {engine.fellBack && (
        <Text as="p" size="xs" tone="muted">
          The GPU path failed on this device, so tracking switched to the CPU and the current set
          restarted. Your neutral is kept — recalibrate if the angles look off.
        </Text>
      )}
      {engine.cpuAfterCrash && (
        <div className="flex flex-wrap items-center gap-2">
          <Text size="xs" tone="muted">
            Running on the CPU: the last GPU start didn&apos;t finish.
          </Text>
          <Button variant="quiet" size="sm" onClick={() => engine.setForcedCpu(false)}>
            Try the GPU
          </Button>
        </div>
      )}

      {contra && !acknowledged ? (
        <Card className="p-5">
          <Text size="sm" tone="muted">
            Acknowledge the caution above to begin this exercise.
          </Text>
        </Card>
      ) : (
        <ExercisePanel
          def={shown}
          sample={engine.sample}
          state={engine.exState}
          idle={engine.status === 'idle'}
          calibrated={engine.calibrated}
          onControl={engine.control}
        />
      )}

      <SessionLine engine={engine} def={def} sets={sets} />
      <UnsavedSetsStrip />
      <RepTieStrip handle={rep} activeMs={engine.activeMs()} />
      <DebugReadout engine={engine} />
    </div>
  );
}

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

// Right / Left by where the head mainly goes (D48) — Right first, whichever stored side it is.
function SideToggle({
  def,
  side,
  onChange,
}: {
  def: ExerciseDefinition;
  side: Side;
  onChange: (s: Side) => void;
}) {
  const sides = (['a', 'b'] as const)
    .map((s) => ({ s, label: sideLabel(def, s) }))
    .sort((x, y) => (x.label === 'Right' ? -1 : y.label === 'Right' ? 1 : 0));
  return (
    <div className="flex flex-col gap-1">
      <div
        role="group"
        aria-label="Side"
        className="inline-flex gap-0.5 self-start rounded-xl border border-line bg-surface p-0.5"
      >
        {sides.map(({ s, label }) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => onChange(s)}
            className={cx(
              'rounded-[0.625rem] px-3 py-1.5 text-sm transition',
              side === s ? 'bg-teal-soft font-medium text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <Text size="xs" tone="muted">
        Each side is named for where your head goes — the next set switches sides on its own.
      </Text>
    </div>
  );
}

function SessionLine({
  engine,
  def,
  sets,
}: {
  engine: ReturnType<typeof useFluxEngine>;
  def: ExerciseDefinition;
  sets: number;
}) {
  // Of the plan, only finished sets count (as the session's own count does); stopped ones are said apart.
  const stopped = engine.sessionSets.filter((s) => s.stoppedEarly).length;
  const n = engine.sessionSets.length - stopped;
  const rom = engine.sample.rom;
  const showRom = engine.status === 'running' && engine.calibrated && def.measurement !== 'guided';
  if (n + stopped === 0 && !showRom) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {n + stopped > 0 && (
        <Text size="sm" tone="muted" tabular>
          Sets this session · {n} of {sets}
          {stopped > 0 && ` · ${stopped} stopped early`}
        </Text>
      )}
      {showRom && (
        <Text size="sm" tone="muted" tabular>
          Range since calibrating · nod {rom.pitch.toFixed(0)}° · turn {rom.yaw.toFixed(0)}° · tilt{' '}
          {rom.roll.toFixed(0)}°
        </Text>
      )}
    </div>
  );
}
