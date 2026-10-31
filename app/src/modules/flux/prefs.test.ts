import { describe, expect, it } from 'vitest';
import {
  clearGpuBoot,
  markGpuBoot,
  preferredDelegate,
  readCondition,
  readStage,
  readVoiceEnabled,
  readVoiceId,
  writeCondition,
  writeForcedCpu,
  writeStage,
  writeVoiceEnabled,
  writeVoiceId,
} from './prefs';

describe('flux prefs', () => {
  it('voice is on by default and remembers off', () => {
    expect(readVoiceEnabled()).toBe(true);
    writeVoiceEnabled(false);
    expect(readVoiceEnabled()).toBe(false);
    writeVoiceEnabled(true);
    expect(readVoiceEnabled()).toBe(true);
  });

  it('the voice id round-trips and clears on empty', () => {
    writeVoiceId('com.apple.voice.enhanced.en-US.Samantha');
    expect(readVoiceId()).toBe('com.apple.voice.enhanced.en-US.Samantha');
    writeVoiceId('');
    expect(readVoiceId()).toBeNull();
  });

  it('a voice saved by name before D58 is still read, and the next pick replaces it', () => {
    localStorage.setItem('aperture.flux.voiceName', 'Samantha');
    expect(readVoiceId()).toBe('Samantha');
    writeVoiceId('com.apple.voice.premium.en-US.Zoe');
    expect(localStorage.getItem('aperture.flux.voiceName')).toBeNull();
    expect(readVoiceId()).toBe('com.apple.voice.premium.en-US.Zoe');
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
