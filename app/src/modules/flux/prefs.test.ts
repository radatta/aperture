import { describe, expect, it } from 'vitest';
import {
  clearGpuBoot,
  markGpuBoot,
  preferredDelegate,
  readCondition,
  readStage,
  readVoiceEnabled,
  readVoiceName,
  writeCondition,
  writeForcedCpu,
  writeStage,
  writeVoiceEnabled,
  writeVoiceName,
} from './prefs';

describe('flux prefs', () => {
  it('voice is on by default and remembers off', () => {
    expect(readVoiceEnabled()).toBe(true);
    writeVoiceEnabled(false);
    expect(readVoiceEnabled()).toBe(false);
    writeVoiceEnabled(true);
    expect(readVoiceEnabled()).toBe(true);
  });

  it('voice name round-trips and clears on empty', () => {
    writeVoiceName('Samantha');
    expect(readVoiceName()).toBe('Samantha');
    writeVoiceName('');
    expect(readVoiceName()).toBeNull();
  });

  it('condition and stage reject values outside the catalog', () => {
    writeCondition('herniatedDisc');
    writeStage('acute');
    expect(readCondition()).toBe('herniatedDisc');
    expect(readStage()).toBe('acute');
    localStorage.setItem('aperture.flux.condition', 'bogus');
    localStorage.setItem('aperture.flux.stage', 'bogus');
    expect(readCondition()).toBeNull();
    expect(readStage()).toBeNull();
  });

  it('starts on GPU, and on CPU when forced or after an unfinished GPU boot', () => {
    expect(preferredDelegate()).toBe('GPU');
    markGpuBoot();
    expect(preferredDelegate()).toBe('CPU');
    clearGpuBoot();
    expect(preferredDelegate()).toBe('GPU');
    writeForcedCpu(true);
    expect(preferredDelegate()).toBe('CPU');
    writeForcedCpu(false);
    expect(preferredDelegate()).toBe('GPU');
  });
});
