import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getExercise, type ExerciseState } from '@aperture/shared/flux';
import { initialState } from './engine/evaluate';
import { StageReadout } from './StageReadout';

describe('StageReadout', () => {
  it('between sets the note is the rest countdown, in two lines; gone with the rest', () => {
    const def = getExercise('chin-tuck');
    const done = { ...initialState(def), phase: 'complete', holdsDone: 6 } as ExerciseState;
    const { rerender } = render(
      <StageReadout def={def} state={done} rest={{ remainingSec: 23, next: 2 }} />,
    );
    const note = screen.getByText(/Rest · 23 s/);
    expect(note.textContent).toBe('Rest · 23 sSet two next'); // a <br> between the two lines
    expect(note.querySelector('br')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy(); // the finished count stays above it
    rerender(<StageReadout def={def} state={done} rest={null} />);
    expect(screen.queryByText(/Rest · /)).toBeNull();
  });

  it('a reposition prompt is the note while a trial runs', () => {
    const def = getExercise('joint-position-sense');
    const active = { ...initialState(def), phase: 'active', sub: 'away' } as ExerciseState;
    render(<StageReadout def={def} state={active} rest={null} />);
    expect(screen.getByText('Turn away')).toBeTruthy();
  });
});
