import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getExercise, type ExerciseDefinition, type ExerciseState } from '@aperture/shared/flux';
import { initialState } from './engine/evaluate';
import type { Sample } from './engine/protocol';
import { ExercisePanel } from './ExercisePanel';
import { IDLE_SAMPLE } from './useFluxEngine';

const at = (rel: Partial<Sample['rel']>): Sample => ({
  ...IDLE_SAMPLE,
  faceVisible: true,
  rel: { ...IDLE_SAMPLE.rel, ...rel },
});

function panel(def: ExerciseDefinition, state: ExerciseState | null, sample = IDLE_SAMPLE) {
  const onControl = vi.fn();
  render(<ExercisePanel def={def} sample={sample} state={state} onControl={onControl} />);
  return onControl;
}

describe('ExercisePanel', () => {
  it('waits for the engine with "Getting ready…", and always shows the instructions and cues', () => {
    const def = getExercise('cervical-rotation');
    panel(def, null);
    expect(screen.getByText('Getting ready…')).toBeTruthy();
    expect(screen.getByText(def.instructions)).toBeTruthy();
    for (const c of def.cues) expect(screen.getByText(c)).toBeTruthy();
  });

  it('before the camera starts, says so instead of "Getting ready…"', () => {
    render(
      <ExercisePanel
        def={getExercise('chin-tuck')}
        sample={IDLE_SAMPLE}
        state={null}
        idle
        onControl={vi.fn()}
      />,
    );
    expect(screen.getByText('Start the camera to begin.')).toBeTruthy();
    expect(screen.queryByText('Getting ready…')).toBeNull();
  });

  it('romReps: count, hold ring, progress toward target, both sides, compensation warning', () => {
    const def = getExercise('cervical-rotation');
    const state = {
      ...initialState(def),
      repsPos: 3,
      repsNeg: 2,
      compensating: true,
    } as ExerciseState;
    panel(def, state, at({ yaw: 30 }));
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('/ 20 reps')).toBeTruthy();
    expect(screen.getByText('current +30°')).toBeTruthy();
    expect(screen.getByText('target 60°')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('Side A')).toBeTruthy();
    expect(screen.getByText('Side B')).toBeTruthy();
    expect(screen.getByText('hold 4s to count')).toBeTruthy();
    expect(screen.getByText(/Keep steady — move only in this plane/)).toBeTruthy();
    // The hold zone's mark on the bar: 45° of 60° (D36).
    expect(screen.getByTestId('hold-zone-mark').style.left).toBe('75%');
  });

  it('romReps short of the hold zone asks for a little further; in it, times the hold', () => {
    const def = getExercise('cervical-rotation');
    const out = { ...initialState(def), zone: 'positive' } as ExerciseState;
    const { unmount } = render(
      <ExercisePanel def={def} sample={at({ yaw: 30 })} state={out} onControl={() => {}} />,
    );
    expect(screen.getByText('a little further')).toBeTruthy();
    expect(screen.getByText('further')).toBeTruthy();
    unmount();
    panel(def, { ...out, inHoldZone: true, holdAccumSec: 1 } as ExerciseState, at({ yaw: 50 }));
    expect(screen.getByText('hold at end range')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('romReps without a hold has no zone mark', () => {
    const def = getExercise('eye-head-coordination');
    panel(def, initialState(def));
    expect(screen.queryByTestId('hold-zone-mark')).toBeNull();
  });

  it('romReps complete: Set complete + Again (new in Aperture)', async () => {
    const def = getExercise('cervical-flexion');
    const state = { ...initialState(def), phase: 'complete', repsPos: 10 } as ExerciseState;
    const onControl = panel(def, state);
    expect(screen.getByText('Set complete')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Again' }));
    expect(onControl).toHaveBeenCalledWith({ type: 'start' });
  });

  it('holdAtTarget: direction chips until aligned, then "In position — hold"', () => {
    const def = getExercise('levator-scapulae-stretch'); // yaw 30, pitch 20, tolerance 14
    const state = initialState(def);
    const { unmount } = render(
      <ExercisePanel def={def} sample={at({})} state={state} onControl={() => {}} />,
    );
    expect(screen.getByText('Turn ▲ 30°')).toBeTruthy();
    expect(screen.getByText('Nod ▲ 20°')).toBeTruthy();
    expect(screen.getByText('get in position')).toBeTruthy();
    expect(screen.getByText('Hold 0 / 2')).toBeTruthy();
    unmount();
    panel(
      def,
      { ...state, inPosition: true, holdElapsedSec: 4 } as ExerciseState,
      at({ yaw: 31, pitch: 19 }),
    );
    expect(screen.getByText('In position — hold')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy(); // seconds left of 10
  });

  it('holdAtTarget complete: Set complete + Again (new in Aperture)', () => {
    const def = getExercise('chin-tuck');
    panel(def, { ...initialState(def), phase: 'complete', holdsDone: 10 } as ExerciseState);
    expect(screen.getByText('Set complete')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Again' })).toBeTruthy();
  });

  it('guidedHold: Start block, then HOLD / rest ring, rep count, drift warning', async () => {
    const def = getExercise('deep-neck-flexor');
    const onControl = panel(def, initialState(def));
    // Starts itself once the neutral is set (D41); the button is the override.
    expect(screen.getByText('10 reps · starts once your neutral is set')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start now' }));
    expect(onControl).toHaveBeenCalledWith({ type: 'start' });
    render(
      <ExercisePanel
        def={def}
        sample={IDLE_SAMPLE}
        state={
          {
            ...initialState(def),
            phase: 'active',
            segment: 'hold',
            segmentElapsedSec: 4,
            drifting: true,
          } as ExerciseState
        }
        onControl={() => {}}
      />,
    );
    expect(screen.getByText('HOLD')).toBeTruthy();
    expect(screen.getByText('Rep 1 / 10')).toBeTruthy();
    cleanup();
    // Once the neutral is set the lead-in is running: no longer "once your neutral is set".
    render(
      <ExercisePanel
        def={def}
        sample={IDLE_SAMPLE}
        state={initialState(def)}
        calibrated
        onControl={() => {}}
      />,
    );
    expect(screen.getByText('10 reps · starting…')).toBeTruthy();
    cleanup();
    render(
      <ExercisePanel
        def={def}
        sample={IDLE_SAMPLE}
        state={
          {
            ...initialState(def),
            phase: 'active',
            segment: 'hold',
            segmentElapsedSec: 4,
            drifting: true,
          } as ExerciseState
        }
        onControl={() => {}}
      />,
    );
    expect(screen.getByText('Keep your head still')).toBeTruthy();
    expect(screen.getAllByText(/the angle isn't measured/).length).toBeGreaterThan(0);
  });

  it('reposition: trials, the prompt for each sub-phase, and the average error', () => {
    const def = getExercise('joint-position-sense');
    panel(def, {
      ...initialState(def),
      phase: 'active',
      sub: 'returning',
      trialsDone: 2,
      errorSum: 7,
      errorCount: 2,
    } as ExerciseState);
    expect(screen.getByText('Now return to your neutral')).toBeTruthy();
    expect(screen.getByText('avg error 3.5°')).toBeTruthy();
    expect(screen.getByText(/\/ \d+ trials/)).toBeTruthy();
  });

  it('oscillation: seconds ring, cycles and swing; "30s" before starting', () => {
    const def = getExercise('gaze-stability');
    const { unmount } = render(
      <ExercisePanel
        def={def}
        sample={IDLE_SAMPLE}
        state={initialState(def)}
        onControl={() => {}}
      />,
    );
    expect(screen.getByText('30s · starts once your neutral is set')).toBeTruthy();
    unmount();
    panel(def, {
      ...initialState(def),
      phase: 'active',
      elapsedSec: 10,
      cycles: 4.6,
      amplitudeEwma: 22,
    } as ExerciseState);
    expect(screen.getByText('seconds')).toBeTruthy();
    expect(screen.getByText('4 cycles · ~22° swing')).toBeTruthy();
  });
});
