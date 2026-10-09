// The cervical-rehab exercise library, as data. Sourced from clinical PT
// references (Physiopedia, NHS, McKenzie/MDT, PMC reviews) and mapped to what a
// webcam head-pose engine can actually observe. Validated at COMPILE TIME via
// `as const satisfies` — no runtime schema dependency (see docs/areas/flux).
//
// SIGN CONVENTION (assumed; must be verified on-device — see docs/areas/flux):
//   pitch  +flexion (chin down)   / −extension (look up)   [verified on-device]
//   yaw    +turn right            / −turn left             [unverified — phase-8 dev test]
//   roll   +tilt right (ear→R)    / −tilt left (ear→L)     [unverified — phase-8 dev test]
// Bilateral ROM exercises are sign-agnostic; only the single-direction pitch
// drills and the stretch target positions depend on this convention. Flipping a
// wrong one is a one-field change.

import type { ExerciseDefinition } from './types';

export const EXERCISES = [
  // ─── A. Active ROM — cleanly measured ─────────────────────────────────────
  {
    id: 'cervical-rotation',
    name: 'Neck Rotation',
    tracker: 'face',
    kind: 'romReps',
    measurement: 'measured',
    axis: 'yaw',
    direction: 'bilateral',
    enterDeg: 15,
    exitDeg: 8,
    targetDeg: 60,
    reps: 10,
    holdSec: 2,
    instructions:
      'Sit tall, eyes forward. Slowly turn your head to look over one shoulder, return to center, then the other side.',
    cues: ['Keep your chin level', 'Move slowly and only as far as is comfortable'],
    precautions: ['Stop if you feel sharp pain or dizziness'],
    conditions: ['herniatedDisc', 'sprainStrain', 'general'],
    stages: ['acute', 'subacute', 'chronic'],
  },
  {
    id: 'cervical-lateral-flexion',
    name: 'Lateral Flexion (Ear to Shoulder)',
    tracker: 'face',
    kind: 'romReps',
    measurement: 'measured',
    axis: 'roll',
    direction: 'bilateral',
    enterDeg: 12,
    exitDeg: 6,
    targetDeg: 40,
    reps: 10,
    holdSec: 2,
    instructions:
      'Tilt your head to bring one ear toward that shoulder without lifting the shoulder. Return to center and repeat the other side.',
    cues: ['Keep both shoulders down and relaxed', "Don't shrug up to fake the range"],
    precautions: ['Stop if pain radiates into the arm'],
    conditions: ['herniatedDisc', 'sprainStrain', 'general'],
    stages: ['acute', 'subacute', 'chronic'],
  },
  {
    id: 'cervical-flexion',
    name: 'Neck Flexion (Chin to Chest)',
    tracker: 'face',
    kind: 'romReps',
    measurement: 'measured',
    axis: 'pitch',
    direction: 'positive',
    enterDeg: 15,
    exitDeg: 8,
    targetDeg: 45,
    reps: 10,
    holdSec: 2,
    instructions: 'Slowly lower your chin toward your chest, then return to neutral.',
    cues: ['Move smoothly, no bouncing'],
    precautions: [
      'Stop if pain spreads down the arm (peripheralization) — flexion can provoke some disc problems',
    ],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'cervical-extension',
    name: 'Neck Extension (Look Up)',
    tracker: 'face',
    kind: 'romReps',
    measurement: 'measured',
    axis: 'pitch',
    direction: 'negative',
    enterDeg: 15,
    exitDeg: 8,
    targetDeg: 55,
    reps: 8,
    holdSec: 2,
    provocative: true,
    instructions: 'Slowly tip your head back to look toward the ceiling, then return to neutral.',
    cues: ['Go slowly', 'Stop at the first sign of dizziness'],
    precautions: [
      'End-range extension can narrow the nerve opening — only continue if it eases (centralizes) arm symptoms',
    ],
    contraindications: [
      {
        condition: 'herniatedDisc',
        stage: 'acute',
        reason:
          'Extension commonly aggravates acute cervical radiculopathy — avoid until symptoms settle.',
      },
    ],
    conditions: ['herniatedDisc', 'general'],
    stages: ['chronic'],
  },

  // ─── B. Hold at a target position — approximate ───────────────────────────
  {
    id: 'chin-tuck',
    name: 'Chin Tuck (Cervical Retraction)',
    tracker: 'face',
    kind: 'holdAtTarget',
    measurement: 'approximate',
    target: { pitch: 5 },
    toleranceDeg: 7,
    holdSec: 4,
    reps: 10,
    instructions:
      "Glide your head straight back to make a gentle 'double chin', keeping your eyes level. Hold, then release.",
    cues: ["Small movement — glide back, don't nod down", 'Keep it gentle, no forcing'],
    precautions: [
      "Approximate: the engine can't measure the true backward glide, only a small nod — use it as a guide",
      'Stop if it pushes pain into the arm',
    ],
    conditions: ['herniatedDisc', 'sprainStrain', 'general'],
    stages: ['acute', 'subacute', 'chronic'],
  },
  {
    id: 'retraction-extension',
    name: 'Retraction + Extension (McKenzie)',
    tracker: 'face',
    kind: 'holdAtTarget',
    measurement: 'approximate',
    target: { pitch: -20 },
    toleranceDeg: 10,
    holdSec: 3,
    reps: 8,
    provocative: true,
    instructions:
      'From a chin-tuck, slowly extend to look up, then return. A derangement-reduction technique — only use if it eases arm symptoms.',
    cues: ['Retract first, then extend', 'Move to comfortable end-range only'],
    precautions: [
      'Only continue if symptoms centralize (arm pain retreats toward the neck); stop if they spread',
    ],
    contraindications: [
      {
        condition: 'herniatedDisc',
        stage: 'acute',
        reason: 'End-range extension can flare an acute, irritable disc.',
      },
    ],
    conditions: ['herniatedDisc', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'upper-trap-stretch',
    name: 'Upper Trapezius Stretch',
    tracker: 'face',
    kind: 'holdAtTarget',
    measurement: 'approximate',
    target: { roll: 28 },
    toleranceDeg: 12,
    holdSec: 30,
    reps: 2,
    instructions:
      'Tilt one ear toward that shoulder with a gentle stretch along the opposite side of the neck. Hold, then repeat the other side.',
    cues: ['Keep the opposite shoulder down', 'Gentle stretch, never a yank'],
    precautions: ['Stop at sharp pain or tingling'],
    conditions: ['sprainStrain', 'general'],
    stages: ['acute', 'subacute', 'chronic'],
  },
  {
    id: 'levator-scapulae-stretch',
    name: 'Levator Scapulae Stretch',
    tracker: 'face',
    kind: 'holdAtTarget',
    measurement: 'approximate',
    target: { yaw: 30, pitch: 20 },
    toleranceDeg: 14,
    holdSec: 30,
    reps: 2,
    instructions:
      'Rotate your head about 45° to one side, then look down toward your armpit until you feel a stretch. Hold, then the other side.',
    cues: ['Nose toward the armpit', 'Ease in gently'],
    precautions: ['Stop at sharp or radiating pain'],
    conditions: ['general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'scalene-stretch',
    name: 'Scalene Stretch',
    tracker: 'face',
    kind: 'holdAtTarget',
    measurement: 'approximate',
    target: { roll: -22, yaw: 18, pitch: -10 },
    toleranceDeg: 14,
    holdSec: 30,
    reps: 2,
    instructions:
      'Tilt your head away from the tight side and rotate to look slightly up and over the opposite shoulder. Hold gently.',
    cues: ['Keep the stretch mild'],
    precautions: [
      'Stop immediately if you get arm tingling or numbness — the scalenes overlie the brachial plexus (thoracic outlet)',
    ],
    conditions: ['general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'eye-head-coordination',
    name: 'Eye–Head Coordination',
    tracker: 'face',
    kind: 'romReps',
    measurement: 'approximate',
    axis: 'yaw',
    direction: 'bilateral',
    enterDeg: 15,
    exitDeg: 8,
    targetDeg: 40,
    reps: 8,
    instructions:
      'Look toward a target to one side with your eyes first, then turn your head to follow and line up with it. Return and repeat both ways.',
    cues: ['Eyes lead, head follows', 'Keep the target in focus'],
    precautions: ['Slow down if you feel dizzy'],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },

  // ─── C. Guided / isometric — not angle-measured (timer + drift check) ──────
  {
    id: 'deep-neck-flexor',
    name: 'Deep Neck Flexor Hold',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 10,
    reps: 10,
    restSec: 5,
    driftToleranceDeg: 8,
    instructions:
      "Make a tiny, slow 'yes' nod at the very top of your neck to switch on the deep muscles, and hold it steady. Keep the movement subtle.",
    cues: ["Don't lift or jut the head", 'No jaw clenching'],
    precautions: [
      "Guided only — the engine times the hold and warns if your head drifts, it doesn't measure the effort",
    ],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'isometric-flexion',
    name: 'Isometric Flexion Hold',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 10,
    reps: 5,
    restSec: 5,
    driftToleranceDeg: 8,
    instructions:
      'Place a palm on your forehead and gently press your head forward into it — without letting your head actually move. Hold.',
    cues: ['About 50% effort', "Keep breathing, don't hold your breath"],
    precautions: ['Guided only — keep your head still; the engine warns if it drifts off neutral'],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'isometric-extension',
    name: 'Isometric Extension Hold',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 10,
    reps: 5,
    restSec: 5,
    driftToleranceDeg: 8,
    instructions:
      'Cup the back of your head with your hands and gently press your head backward into them — without moving. Hold.',
    cues: ['About 50% effort', 'Keep breathing'],
    precautions: ['Stop if you feel dizzy or symptoms radiate'],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'isometric-lateral-flexion',
    name: 'Isometric Side-Bend Hold',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 10,
    reps: 5,
    restSec: 5,
    driftToleranceDeg: 8,
    instructions:
      'Place a palm against the side of your head and press sideways into it without moving your head. Hold, then switch sides.',
    cues: ['Keep your head vertical', 'Submaximal, steady effort'],
    precautions: ['Guided only — head stays still; drift is flagged'],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'isometric-rotation',
    name: 'Isometric Rotation Hold',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 10,
    reps: 5,
    restSec: 5,
    driftToleranceDeg: 8,
    instructions:
      'Place a palm against the side of your forehead and try to turn your head into it without moving. Hold, then the other side.',
    cues: ['Head stays facing forward', 'About 50% effort'],
    precautions: ['Stop if symptoms radiate'],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'scapular-retraction',
    name: 'Scapular Retraction (Posture Set)',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 10,
    reps: 10,
    restSec: 3,
    driftToleranceDeg: 12,
    instructions:
      'Sit tall and gently draw your shoulder blades down and back, as if tucking them into your back pockets. Hold.',
    cues: ["Don't shrug up", 'Keep your neck relaxed and level'],
    precautions: [
      "Guided only — this is shoulder-blade work the head-pose engine can't see; it just times the hold",
    ],
    conditions: ['herniatedDisc', 'sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'median-nerve-glide',
    name: 'Median Nerve Glide',
    tracker: 'face',
    kind: 'guidedHold',
    measurement: 'guided',
    holdSec: 3,
    reps: 10,
    restSec: 2,
    driftToleranceDeg: null,
    instructions:
      "Gently 'floss' the nerve: as you straighten your arm out to the side, tilt your head away; as you bend the arm back, bring your head back to center. Slow and smooth.",
    cues: ['Gentle glide, never a hard stretch', 'Sliders, not a big pull'],
    precautions: [
      'Pure guide, no measurement',
      "Move slowly and back off if it increases arm symptoms — don't aggressively tension an irritable nerve",
    ],
    conditions: ['herniatedDisc'],
    stages: ['subacute', 'chronic'],
  },

  // ─── D. Sensorimotor — partially measured ─────────────────────────────────
  {
    id: 'joint-position-sense',
    name: 'Joint Position Sense (Return to Neutral)',
    tracker: 'face',
    kind: 'reposition',
    measurement: 'approximate',
    axis: 'any',
    excursionDeg: 25,
    settleSec: 2,
    reps: 10,
    instructions:
      'Close your eyes, turn or tip your head away, then try to bring it back to your exact neutral starting position. Open your eyes to see how close you got.',
    cues: ['Trust your sense of position', 'Move back smoothly, then hold still'],
    precautions: [
      'Measures how far you land from your calibrated neutral — recalibrate neutral first',
      'Slow down if you feel dizzy',
    ],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
  {
    id: 'gaze-stability',
    name: 'Gaze Stability (VOR)',
    tracker: 'face',
    kind: 'oscillation',
    measurement: 'approximate',
    axis: 'yaw',
    targetAmplitudeDeg: 20,
    targetCadenceHz: 0.8,
    durationSec: 30,
    instructions:
      "Fix your eyes on a target at arm's length and keep it in focus while you turn your head smoothly side to side.",
    cues: ['Keep the target sharp', 'Steady rhythm, comfortable range'],
    precautions: [
      "Measures your head's side-to-side motion, not your gaze — reduce speed if dizziness flares",
    ],
    conditions: ['sprainStrain', 'general'],
    stages: ['subacute', 'chronic'],
  },
] as const satisfies readonly ExerciseDefinition[];

export type ExerciseId = (typeof EXERCISES)[number]['id'];

export function getExercise(id: ExerciseId): ExerciseDefinition {
  const found = EXERCISES.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown exercise: ${id}`);
  return found;
}

export const FLUX_EXERCISE_IDS: readonly ExerciseId[] = EXERCISES.map((e) => e.id);

export function isExerciseId(id: string): id is ExerciseId {
  return (FLUX_EXERCISE_IDS as readonly string[]).includes(id);
}
