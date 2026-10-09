import { useState } from 'react';
import type { Condition, Stage } from '@aperture/shared/flux';
import { useRolls } from '../../data/hooks/useRolls';
import { useSettings } from '../../data/hooks/useSettings';
import { ExerciseLibrary } from '../../modules/flux/ExerciseLibrary';
import { readCondition, readStage, writeCondition, writeStage } from '../../modules/flux/prefs';
import { UnlinkedRollNote } from '../../modules/flux/RepTie';

// /flux — the exercise library. The condition and stage chips stick (per device): the condition is
// what makes a contraindication show on the stage, so resetting it on Back (flux did) would hide one.
export function FluxLibraryTab() {
  const [condition, setCondition] = useState<Condition | null>(readCondition);
  const [stage, setStage] = useState<Stage | null>(readStage);
  const { data: settings } = useSettings();
  const { data: rolls } = useRolls();
  const linked =
    settings?.fluxRollId != null && !!rolls?.some((r) => r.id === settings.fluxRollId && r.active);

  return (
    <div className="flex flex-col gap-5">
      {settings && rolls && !linked && <UnlinkedRollNote />}
      <ExerciseLibrary
        condition={condition}
        onConditionChange={(c) => {
          setCondition(c);
          writeCondition(c);
        }}
        stage={stage}
        onStageChange={(s) => {
          setStage(s);
          writeStage(s);
        }}
      />
    </div>
  );
}
