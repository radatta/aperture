import type { Condition, Stage } from '@aperture/shared/flux';
import type { Delegate } from './engine/protocol';

// Per-device Flux preferences. Voices differ per OS and the delegate is a property of this device's GPU,
// so these never sync; the linked Roll and the disclaimer acknowledgement live in Settings instead.
const VOICE = 'aperture.flux.voice';
const VOICE_NAME = 'aperture.flux.voiceName';
const CONDITION = 'aperture.flux.condition';
const STAGE = 'aperture.flux.stage';
const DELEGATE = 'aperture.flux.delegate';
// Set just before a GPU init and cleared after the first good detect. Still set on the next launch
// means the last GPU attempt took the page down — that launch starts on CPU.
const GPU_BOOT = 'aperture.flux.gpuBoot';

const CONDITIONS: readonly Condition[] = ['herniatedDisc', 'sprainStrain', 'general'];
const STAGES: readonly Stage[] = ['acute', 'subacute', 'chronic'];

// Storage can throw (private mode, blocked site data) — every read/write degrades to "not stored".
function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not persisted — the in-memory state still works for this visit
  }
}

export const readVoiceEnabled = (): boolean => get(VOICE) !== '0';
export const writeVoiceEnabled = (on: boolean) => set(VOICE, on ? '1' : '0');

export const readVoiceName = (): string | null => get(VOICE_NAME) || null;
export const writeVoiceName = (name: string | null) => set(VOICE_NAME, name || null);

export function readCondition(): Condition | null {
  const v = get(CONDITION);
  return CONDITIONS.find((c) => c === v) ?? null;
}
export const writeCondition = (c: Condition | null) => set(CONDITION, c);

export function readStage(): Stage | null {
  const v = get(STAGE);
  return STAGES.find((s) => s === v) ?? null;
}
export const writeStage = (s: Stage | null) => set(STAGE, s);

/** CPU when the user forced it or the last GPU boot never finished; GPU otherwise. */
export const preferredDelegate = (): Delegate =>
  get(DELEGATE) === 'CPU' || get(GPU_BOOT) ? 'CPU' : 'GPU';
export const readForcedCpu = (): boolean => get(DELEGATE) === 'CPU';
export const writeForcedCpu = (on: boolean) => set(DELEGATE, on ? 'CPU' : null);

export const markGpuBoot = () => set(GPU_BOOT, '1');
export const clearGpuBoot = () => set(GPU_BOOT, null);
