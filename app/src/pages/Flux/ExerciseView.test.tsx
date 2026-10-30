import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient, STUB_FAIL_FLUX_SAVE_KEY } from '../../data/stubClient';
import { FLUX_OUTBOX_KEY } from '../../modules/flux/fluxOutbox';
import { setFluxEngineFactory } from '../../modules/flux/engine/engine';
import { createFakeEngine, type FakeControls } from '../../modules/flux/engine/fakeEngine';
import { initialState } from '../../modules/flux/engine/evaluate';
import { getExercise, type ExerciseId, type ExerciseState } from '@aperture/shared/flux';

// The stage over a scripted engine: every status, overlay and gate, without a camera or a worker.

async function stage(
  path: string,
  prep?: (api: ReturnType<typeof createStubClient>) => Promise<void>,
) {
  const api = createStubClient({ seed: false, storageKey: `flux-stage-${Math.random()}` });
  await api.updateSettings({ fluxDisclaimerAckAt: 1 });
  await prep?.(api);
  let fake: FakeControls | undefined;
  setFluxEngineFactory(() => {
    const f = createFakeEngine();
    fake = f.fake;
    return f.engine;
  });
  const user = userEvent.setup();
  renderApp({ api, path });
  await screen.findByRole('button', { name: 'Start camera' });
  const f = () => {
    if (!fake) throw new Error('engine not created');
    return fake;
  };
  return { api, user, fake: f };
}

// Start and reach the running HUD.
async function running(s: Awaited<ReturnType<typeof stage>>) {
  await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
  act(() => s.fake().ready('GPU'));
  await screen.findByRole('button', { name: 'Calibrate neutral' });
}

describe('Flux exercise stage', () => {
  it('a deep link renders the idle stage; an unknown id says so', async () => {
    const s = await stage('/flux/cervical-rotation');
    expect(screen.getByText('Neck Rotation')).toBeTruthy();
    expect(screen.getByText(/Sit facing the camera/)).toBeTruthy();
    renderApp({ api: s.api, path: '/flux/nope' });
    expect(await screen.findByText('No such exercise.')).toBeTruthy();
  });

  it('Start → download progress → running HUD on the reported delegate', async () => {
    const s = await stage('/flux/cervical-rotation');
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(screen.getByRole('button', { name: 'Loading model…' })).toHaveProperty('disabled', true);
    act(() => s.fake().progress(1_000_000, 3_758_596));
    expect(screen.getByText('Downloading model… 1.0 / 3.8 MB')).toBeTruthy();
    act(() => s.fake().ready('GPU'));
    expect(await screen.findByRole('button', { name: 'Calibrate neutral' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Running on the GPU/ })).toBeTruthy();
    act(() => s.fake().sample({ faceVisible: false, fps: 28 }));
    expect(screen.getByText(/No face · 28 fps/)).toBeTruthy();
    expect(s.fake().calls[0]).toBe('select:cervical-rotation:a');
    expect(s.fake().calls).toContain('start');
  });

  it('an error stays on screen (flux lost it) and Try again restarts', async () => {
    const s = await stage('/flux/chin-tuck');
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    act(() => s.fake().fail('camera', 'Camera access is blocked.'));
    expect((await screen.findByRole('alert')).textContent).toMatch('Camera access is blocked.');
    expect(s.fake().calls).toContain('stop');
    await s.user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(s.fake().calls.filter((c) => c === 'start')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Loading model…' })).toBeTruthy();
  });

  it('an asset failure leads with what went wrong in plain words', async () => {
    const s = await stage('/flux/chin-tuck');
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    act(() => s.fake().fail('assets', 'HTTP 404'));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Couldn’t download the tracking model/,
    );
  });

  it('calibration: hint until set, refusal without a face, then Re-calibrate', async () => {
    const s = await stage('/flux/cervical-rotation');
    await running(s);
    expect(screen.getByText(/your neutral sets itself/)).toBeTruthy();
    await s.user.click(screen.getByRole('button', { name: 'Calibrate neutral' }));
    expect(s.fake().calls).toContain('calibrate');
    act(() => s.fake().calibrated(false));
    expect(screen.getByText('Face the camera to calibrate')).toBeTruthy();
    act(() => s.fake().calibrated(true));
    expect(screen.getByText('Neutral set')).toBeTruthy();
    expect(screen.queryByText(/your neutral sets itself/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Re-calibrate' })).toBeTruthy();
    expect(screen.getByText(/Range since calibrating/)).toBeTruthy();
  });

  it('pauses when the camera goes away and resumes on a tap', async () => {
    const s = await stage('/flux/cervical-rotation');
    await running(s);
    act(() => s.fake().pause());
    expect(screen.getByText(/Camera paused/)).toBeTruthy();
    await s.user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(s.fake().calls).toContain('resume');
    expect(screen.getByRole('button', { name: 'Calibrate neutral' })).toBeTruthy();
  });

  it('a contraindication gates the exercise until acknowledged', async () => {
    localStorage.setItem('aperture.flux.condition', 'herniatedDisc');
    const s = await stage('/flux/cervical-extension');
    expect(screen.getByText(/Caution for herniated disc/)).toBeTruthy();
    expect(screen.getByText('Acknowledge the caution above to begin this exercise.')).toBeTruthy();
    expect(s.fake().lastSelect).toEqual({ id: null, side: 'a' });
    await s.user.click(screen.getByRole('button', { name: 'I understand — let me continue' }));
    expect(s.fake().lastSelect).toEqual({ id: 'cervical-extension', side: 'a' });
    expect(screen.queryByText('Acknowledge the caution above to begin this exercise.')).toBeNull();
  });

  it('one-sided stretches get a Right / Left toggle that re-selects mirrored', async () => {
    const s = await stage('/flux/upper-trap-stretch');
    await s.user.click(screen.getByRole('button', { name: 'Left' }));
    expect(s.fake().lastSelect).toEqual({ id: 'upper-trap-stretch', side: 'b' });
    expect(screen.getByRole('button', { name: 'Left', pressed: true })).toBeTruthy();
  });

  it('scalene names its sides by the tilt: its Right is the mirrored side (D48)', async () => {
    const s = await stage('/flux/scalene-stretch');
    const group = screen.getByRole('group', { name: 'Side' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Right', 'Left']);
    expect(screen.getByRole('button', { name: 'Left', pressed: true })).toBeTruthy(); // Side A tilts left
    await s.user.click(screen.getByRole('button', { name: 'Right' }));
    expect(s.fake().lastSelect).toEqual({ id: 'scalene-stretch', side: 'b' });
  });

  it('exercises without a side have no toggle', async () => {
    await stage('/flux/chin-tuck');
    expect(screen.queryByRole('button', { name: 'Left' })).toBeNull();
  });

  it('Back stops the engine before leaving for the library', async () => {
    const s = await stage('/flux/cervical-rotation');
    await running(s);
    await s.user.click(screen.getByRole('link', { name: /All exercises/ }));
    expect(await screen.findByText('Chin Tuck (Cervical Retraction)')).toBeTruthy();
    expect(s.fake().calls).toContain('stop');
  });

  it('the voice toggle persists per device', async () => {
    const s = await stage('/flux/cervical-rotation');
    await running(s);
    await s.user.click(screen.getByRole('button', { name: 'Mute voice cues' }));
    expect(localStorage.getItem('aperture.flux.voice')).toBe('0');
    expect(screen.getByRole('button', { name: 'Enable voice cues' })).toBeTruthy();
  });

  it('the delegate glyph switches to CPU', async () => {
    const s = await stage('/flux/cervical-rotation');
    await running(s);
    await s.user.click(screen.getByRole('button', { name: /Running on the GPU/ }));
    expect(s.fake().calls).toContain('forcedCpu:true');
  });

  it('says so when the engine fell back to CPU on its own', async () => {
    const s = await stage('/flux/cervical-rotation');
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    act(() => s.fake().ready('CPU', true));
    expect(await screen.findByText(/switched to the CPU/)).toBeTruthy();
  });

  it('the panel says to start the camera until it is started', async () => {
    const s = await stage('/flux/chin-tuck');
    expect(screen.getByText('Start the camera to begin.')).toBeTruthy();
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(screen.queryByText('Start the camera to begin.')).toBeNull();
  });

  it('a CPU start after a crashed GPU boot says so and offers the GPU again', async () => {
    localStorage.setItem('aperture.flux.gpuBoot', '1');
    const s = await stage('/flux/cervical-rotation');
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    act(() => s.fake().ready('CPU'));
    expect(await screen.findByText(/the last GPU start didn.t finish/)).toBeTruthy();
    await s.user.click(screen.getByRole('button', { name: 'Try the GPU' }));
    expect(s.fake().calls).toContain('forcedCpu:false');
  });

  it('overlays the live count on the video while running, not before', async () => {
    const s = await stage('/flux/cervical-rotation');
    expect(screen.queryByLabelText('Live readout')).toBeNull();
    await running(s);
    const def = getExercise('cervical-rotation');
    act(() => s.fake().state({ ...initialState(def), repsPos: 3, repsNeg: 2 } as ExerciseState));
    const overlay = screen.getByLabelText('Live readout');
    expect(within(overlay).getByText('5')).toBeTruthy();
    expect(within(overlay).getByText(/\/ 20 reps/)).toBeTruthy();
  });

  it.each<[ExerciseId, Record<string, unknown>, RegExp | string]>([
    ['chin-tuck', { inPosition: true, holdElapsedSec: 1 }, '3'],
    ['deep-neck-flexor', { phase: 'active', segment: 'hold', segmentElapsedSec: 4 }, 'HOLD'],
    ['joint-position-sense', { phase: 'active', sub: 'away' }, 'Turn away'],
    ['gaze-stability', { phase: 'active', cycles: 4 }, /cycles/],
  ])('the overlay fits %s', async (id, over, shown) => {
    const s = await stage(`/flux/${id}`);
    await running(s);
    act(() => s.fake().state({ ...initialState(getExercise(id)), ...over } as ExerciseState));
    expect(within(screen.getByLabelText('Live readout')).getByText(shown)).toBeTruthy();
  });

  it('no overlay behind an unacknowledged contraindication', async () => {
    localStorage.setItem('aperture.flux.condition', 'herniatedDisc');
    const s = await stage('/flux/cervical-extension');
    await running(s);
    expect(screen.queryByLabelText('Live readout')).toBeNull();
  });

  it('hides the capture bar on the stage, and Back brings it back', async () => {
    const s = await stage('/flux/chin-tuck');
    // Hidden, not unmounted (the bar keeps its draft): out of the accessibility tree, so no role.
    expect(screen.queryByRole('textbox', { name: 'Capture log' })).toBeNull();
    await s.user.click(screen.getByRole('link', { name: /All exercises/ }));
    expect(await screen.findByRole('textbox', { name: 'Capture log' })).toBeTruthy();
  });

  it('a finished set counts for the session and shows its cue on the HUD', async () => {
    const s = await stage('/flux/chin-tuck');
    await running(s);
    act(() => s.fake().event({ type: 'setCompleted', summary: { count: 5 } }));
    expect(screen.getByText('Sets this session · 1 of 2')).toBeTruthy();
    expect(screen.getByText('Set complete. Well done.')).toBeTruthy();
  });
});

describe('Flux session, hands free (D40–D42)', () => {
  afterEach(() => vi.useRealTimers());

  it('the sets stepper sits beside Start camera: 1–5, two by default, gone once started', async () => {
    const s = await stage('/flux/chin-tuck');
    const group = screen.getByRole('group', { name: 'Sets this session' });
    expect(within(group).getByText('2 sets')).toBeTruthy();
    await s.user.click(screen.getByRole('button', { name: 'Fewer sets' }));
    expect(within(group).getByText('1 set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fewer sets' })).toHaveProperty('disabled', true);
    for (let i = 0; i < 5; i++)
      await s.user.click(screen.getByRole('button', { name: 'More sets' }));
    expect(within(group).getByText('5 sets')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More sets' })).toHaveProperty('disabled', true);
    await s.user.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(screen.queryByRole('group', { name: 'Sets this session' })).toBeNull();
  });

  it('a timed exercise starts itself 3 s after the neutral sets itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = await stage('/flux/deep-neck-flexor');
    await running(s);
    act(() => s.fake().calibrated(true, true));
    expect(screen.getByText('Get ready')).toBeTruthy();
    expect(s.fake().calls).not.toContain('control:start');
    act(() => vi.advanceTimersByTime(3_000));
    expect(s.fake().calls).toContain('control:start');
  });

  it('a sided stretch switches sides after the rest, then ends itself after the last set', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = await stage('/flux/upper-trap-stretch');
    await running(s);
    const done = { type: 'setCompleted', summary: { count: 3 } } as const;
    act(() => s.fake().event(done));
    expect(screen.getByRole('button', { name: 'Right', pressed: true })).toBeTruthy();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('button', { name: 'Left', pressed: true })).toBeTruthy();
    expect(s.fake().lastSelect).toEqual({ id: 'upper-trap-stretch', side: 'b' });
    expect(screen.getByText('Other side')).toBeTruthy();
    act(() => s.fake().event(done));
    expect(s.fake().calls.at(-1)).toBe('stop');
    expect(await screen.findByRole('button', { name: 'Start camera' })).toBeTruthy();
    // The spoken end has a visual mirror on the idle stage, for a muted phone.
    expect(screen.getByText('Session complete.')).toBeTruthy();
  });
});

describe('Flux saved sets (D47, D49)', () => {
  const done = { type: 'setCompleted', summary: { count: 5 } } as const;

  it('a finished set is saved with its exercise, side, count and day', async () => {
    const s = await stage('/flux/chin-tuck');
    await running(s);
    act(() => s.fake().event(done));
    await waitFor(async () => expect(await s.api.listFluxSets()).toHaveLength(1));
    const [set] = await s.api.listFluxSets();
    const { todayKey } = await import('@aperture/shared');
    expect(set).toMatchObject({
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      side: null,
      count: 5,
      day: todayKey(4),
      repTaskId: null,
    });
    expect(localStorage.getItem(FLUX_OUTBOX_KEY)).toBeNull(); // sent, so nothing waits
  });

  it('a failed save stays on the device and on screen until Retry gets it through', async () => {
    const s = await stage('/flux/chin-tuck');
    await running(s);
    localStorage.setItem(STUB_FAIL_FLUX_SAVE_KEY, '1');
    act(() => s.fake().event(done));
    expect(await screen.findByText('1 set not saved yet')).toBeTruthy();
    expect(await screen.findByText(/Last try: Network unavailable/)).toBeTruthy();
    expect(screen.getByText('Sets this session · 1 of 2')).toBeTruthy(); // the session still counts it
    expect(JSON.parse(localStorage.getItem(FLUX_OUTBOX_KEY) ?? '[]')).toHaveLength(1);
    expect(await s.api.listFluxSets()).toEqual([]);

    localStorage.removeItem(STUB_FAIL_FLUX_SAVE_KEY);
    await s.user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('1 set not saved yet')).toBeNull());
    expect(await s.api.listFluxSets()).toHaveLength(1);
  });

  it('Discard asks first, then drops the unsaved set', async () => {
    const s = await stage('/flux/chin-tuck');
    await running(s);
    localStorage.setItem(STUB_FAIL_FLUX_SAVE_KEY, '1');
    act(() => s.fake().event(done));
    await screen.findByText('1 set not saved yet');
    await s.user.click(screen.getByRole('button', { name: 'Discard' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Discard 1 set?' });
    await s.user.click(within(confirm).getByRole('button', { name: 'Keep' }));
    expect(screen.getByText('1 set not saved yet')).toBeTruthy();
    await s.user.click(screen.getByRole('button', { name: 'Discard' }));
    await s.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }),
    );
    expect(screen.queryByText('1 set not saved yet')).toBeNull();
    expect(localStorage.getItem(FLUX_OUTBOX_KEY)).toBeNull();
  });
});

describe('Flux Roll tie', () => {
  async function linked(pick: boolean) {
    let rollId = '';
    const s = await stage('/flux/chin-tuck', async (api) => {
      const roll = await api.upsertRoll({ name: 'Neck', categoryId: null, estimateMin: 15 });
      rollId = roll.id;
      await api.updateSettings({ fluxRollId: roll.id });
      if (pick) await api.pickRollToday(roll.id, (await import('@aperture/shared')).todayKey(4));
    });
    const rep = async () => (await s.api.listTasks()).find((t) => t.rollId === rollId);
    return { ...s, rep };
  }

  it('no rep today → pick one from the stage', async () => {
    const s = await linked(false);
    await s.user.click(await screen.findByRole('button', { name: 'Pick Neck for today' }));
    await waitFor(async () => expect((await s.rep())?.status).toBe('planned'));
    expect(await screen.findByText(/your first finished set starts it/)).toBeTruthy();
  });

  it('first set starts the rep; Stop offers the DoneForm; Mark done finishes it', async () => {
    const s = await linked(true);
    await screen.findByText(/your first finished set starts it/);
    await running(s);
    act(() => s.fake().event({ type: 'setCompleted', summary: { count: 5 } }));
    await waitFor(async () => expect((await s.rep())?.status).toBe('in_progress'));
    expect(await screen.findByText(/Neck rep in progress/)).toBeTruthy();

    await s.user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText("Log today's Neck rep")).toBeTruthy();
    const actual = screen.getByLabelText('Actual (min)') as HTMLInputElement;
    // The session lasted under a minute, so nothing tracked → the field starts empty, never a quiet 0.
    expect(actual.value).toBe('');
    await s.user.type(actual, '12');
    await s.user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(async () => expect((await s.rep())?.status).toBe('done'));
    expect((await s.rep())?.actualAccruedMin).toBe(12);
    expect(await screen.findByText(/Neck rep done today/)).toBeTruthy();
  });

  it('every saved set links to the rep it counted toward — the first, and the next with it running', async () => {
    const s = await linked(true);
    await screen.findByText(/your first finished set starts it/);
    await running(s);
    act(() => s.fake().event({ type: 'setCompleted', summary: { count: 5 } }));
    await waitFor(async () => expect((await s.rep())?.status).toBe('in_progress'));
    act(() => s.fake().event({ type: 'setCompleted', summary: { count: 6 } }));
    await waitFor(async () => expect(await s.api.listFluxSets()).toHaveLength(2));
    const repId = (await s.rep())?.id;
    expect((await s.api.listFluxSets()).map((x) => x.repTaskId)).toEqual([repId, repId]);
  });

  it('a session that ends itself offers the DoneForm with no Stop tap', async () => {
    const s = await linked(true);
    await screen.findByText(/your first finished set starts it/);
    await s.user.click(screen.getByRole('button', { name: 'Fewer sets' }));
    await running(s);
    act(() => s.fake().event({ type: 'setCompleted', summary: { count: 5 } }));
    expect(await screen.findByText("Log today's Neck rep")).toBeTruthy();
    expect(s.fake().calls.at(-1)).toBe('stop');
  });

  it('a later session with no set offers nothing, even after an earlier session logged sets', async () => {
    const s = await linked(true);
    await screen.findByText(/your first finished set starts it/);
    await running(s);
    act(() => s.fake().event({ type: 'setCompleted', summary: { count: 5 } }));
    await screen.findByText(/Neck rep in progress/);
    await s.user.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText("Log today's Neck rep");
    await s.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText("Log today's Neck rep")).toBeNull();

    await running(s);
    await s.user.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => {}); // let a (wrong) onStop settle before asserting it never offered
    expect(screen.queryByText("Log today's Neck rep")).toBeNull();
  });

  it('Stop before any set offers nothing', async () => {
    const s = await linked(true);
    await screen.findByText(/your first finished set starts it/);
    await running(s);
    await s.user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByText("Log today's Neck rep")).toBeNull();
    expect((await s.rep())?.status).toBe('planned');
  });
});

describe('Flux Roll tie loading', () => {
  it('shows nothing while the Roll data loads, then the strip', async () => {
    let release: () => void = () => {};
    await stage('/flux/chin-tuck', async (api) => {
      const roll = await api.upsertRoll({ name: 'Neck', categoryId: null, estimateMin: 15 });
      await api.updateSettings({ fluxRollId: roll.id });
      const listRolls = api.listRolls.bind(api);
      const gate = new Promise<void>((r) => (release = r));
      api.listRolls = async () => {
        await gate;
        return listRolls();
      };
    });
    expect(screen.queryByRole('button', { name: /Pick Neck for today/ })).toBeNull();
    act(() => release());
    expect(await screen.findByRole('button', { name: 'Pick Neck for today' })).toBeTruthy();
  });

  it('a failed Roll load says so inline instead of offering a Pick', async () => {
    await stage('/flux/chin-tuck', async (api) => {
      const roll = await api.upsertRoll({ name: 'Neck', categoryId: null, estimateMin: 15 });
      await api.updateSettings({ fluxRollId: roll.id });
      api.listRolls = async () => {
        throw new Error('offline');
      };
    });
    expect((await screen.findByText(/Couldn.t load your Roll/)).getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('button', { name: /Pick Neck/ })).toBeNull();
  });
});
