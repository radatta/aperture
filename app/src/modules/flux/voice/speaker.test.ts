import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeaker, listLocalVoices } from './speaker';

// jsdom has no speechSynthesis; install a recording stub per test.
type FakeVoice = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>;

let spoken: { text: string; voice: string | undefined }[];
let voices: FakeVoice[];
const synth = {
  getVoices: () => voices,
  speak: (u: { text: string; voice?: FakeVoice }) =>
    spoken.push({ text: u.text, voice: u.voice?.name }),
  cancel: vi.fn(),
  resume: vi.fn(),
};

class FakeUtterance {
  rate = 1;
  lang = '';
  voice: FakeVoice | undefined;
  constructor(public text: string) {}
}

beforeEach(() => {
  spoken = [];
  voices = [
    { name: 'Remote', lang: 'en-US', localService: false },
    { name: 'Thomas', lang: 'fr-FR', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true },
  ];
  synth.cancel.mockClear();
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  Reflect.deleteProperty(window, 'speechSynthesis');
  vi.unstubAllGlobals();
});

describe('speaker', () => {
  it('lists only local voices', () => {
    expect(listLocalVoices().map((v) => v.name)).toEqual(['Thomas', 'Samantha']);
  });

  it('prime speaks the unlock phrase once, inside the gesture', () => {
    const s = createSpeaker({ lang: 'en-US' });
    s.prime('Voice on');
    s.prime('Voice on');
    expect(spoken.map((u) => u.text)).toEqual(['Voice on']);
  });

  it('prefers the named voice, then a local voice in the language, then the first local', () => {
    const voiceFor = (opts: { lang: string; voiceName?: string }) => {
      createSpeaker(opts).speak({ text: 'x', priority: 'normal' });
      return spoken.at(-1)?.voice;
    };
    expect(voiceFor({ lang: 'en-US', voiceName: 'Thomas' })).toBe('Thomas');
    expect(voiceFor({ lang: 'en-US' })).toBe('Samantha');
    expect(voiceFor({ lang: 'de-DE' })).toBe('Thomas');
  });

  it('high priority cancels in-flight speech first', () => {
    const s = createSpeaker({ lang: 'en-US' });
    s.speak({ text: 'normal', priority: 'normal' });
    expect(synth.cancel).not.toHaveBeenCalled();
    s.speak({ text: 'urgent', priority: 'high' });
    expect(synth.cancel).toHaveBeenCalledTimes(1);
  });

  it('retries voice resolution when voices arrive late', () => {
    voices = [];
    const s = createSpeaker({ lang: 'en-US' });
    s.speak({ text: 'early', priority: 'normal' });
    expect(spoken.at(-1)?.voice).toBeUndefined();
    voices = [{ name: 'Samantha', lang: 'en-US', localService: true }];
    s.speak({ text: 'late', priority: 'normal' });
    expect(spoken.at(-1)?.voice).toBe('Samantha');
  });

  it('is a no-op where speech is unsupported', () => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    const s = createSpeaker();
    expect(() => {
      s.prime('Voice on');
      s.speak({ text: 'x', priority: 'high' });
      s.cancel();
    }).not.toThrow();
    expect(listLocalVoices()).toEqual([]);
  });
});
