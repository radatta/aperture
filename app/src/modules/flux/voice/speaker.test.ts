import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeaker, listVoices, pickVoice, rankVoices, voiceQuality } from './speaker';

// jsdom has no speechSynthesis; install a recording stub per test.
type FakeVoice = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'> & {
  voiceURI?: string;
  default?: boolean;
};

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
  it('lists the local voices in the language', () => {
    expect(listVoices('en-US').map((v) => v.name)).toEqual(['Samantha']);
    expect(listVoices('fr-FR').map((v) => v.name)).toEqual(['Thomas']);
  });

  it('prime speaks the unlock phrase once, inside the gesture', () => {
    const s = createSpeaker({ lang: 'en-US' });
    s.prime('Voice on');
    s.prime('Voice on');
    expect(spoken.map((u) => u.text)).toEqual(['Voice on']);
  });

  it('speaks with the saved voice, else the best local voice in the language, else the first local', () => {
    voices.push({ name: 'Ava', lang: 'en-US', localService: true });
    const voiceFor = (opts: { lang: string; voiceId?: string }) => {
      createSpeaker(opts).speak({ text: 'x', priority: 'normal' });
      return spoken.at(-1)?.voice;
    };
    expect(voiceFor({ lang: 'en-US', voiceId: 'Samantha' })).toBe('Samantha'); // saved by name, pre-D58
    expect(voiceFor({ lang: 'en-US' })).toBe('Ava'); // alphabetical among equals
    expect(voiceFor({ lang: 'de-DE' })).toBe('Ava');
  });

  it('high priority cancels in-flight speech first', () => {
    const s = createSpeaker({ lang: 'en-US' });
    s.speak({ text: 'normal', priority: 'normal' });
    expect(synth.cancel).not.toHaveBeenCalled();
    s.speak({ text: 'urgent', priority: 'high' });
    expect(synth.cancel).toHaveBeenCalledTimes(1);
  });

  it('always priority queues behind in-flight speech (the final count before Set complete)', () => {
    const s = createSpeaker({ lang: 'en-US' });
    s.speak({ text: 'Ten', priority: 'always' });
    s.speak({ text: 'Set complete. Well done.', priority: 'always' });
    expect(synth.cancel).not.toHaveBeenCalled();
    expect(spoken.map((u) => u.text)).toEqual(['Ten', 'Set complete. Well done.']);
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

  it('picks again when a better voice is installed after the first cue (iOS loads them late)', () => {
    const s = createSpeaker({ lang: 'en-US' });
    s.speak({ text: 'early', priority: 'normal' });
    expect(spoken.at(-1)?.voice).toBe('Samantha');
    voices = [
      ...voices,
      {
        name: 'Zoe',
        voiceURI: 'com.apple.voice.premium.en-US.Zoe',
        lang: 'en-US',
        localService: true,
      },
    ];
    s.speak({ text: 'late', priority: 'normal' });
    expect(spoken.at(-1)?.voice).toBe('Zoe');
  });

  it('is a no-op where speech is unsupported', () => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    const s = createSpeaker();
    expect(() => {
      s.prime('Voice on');
      s.speak({ text: 'x', priority: 'high' });
      s.cancel();
    }).not.toThrow();
    expect(listVoices()).toEqual([]);
  });
});

describe('voice quality (D58)', () => {
  const v = (name: string, voiceURI: string, extra: Partial<FakeVoice> = {}): FakeVoice => ({
    name,
    voiceURI,
    lang: 'en-US',
    localService: true,
    ...extra,
  });

  it('reads the tier off the URI or the name', () => {
    expect(voiceQuality(v('Zoe', 'com.apple.voice.premium.en-US.Zoe'))).toBe('premium');
    expect(voiceQuality(v('Samantha (Enhanced)', 'Samantha'))).toBe('enhanced');
    expect(voiceQuality(v('Samantha', 'com.apple.voice.compact.en-US.Samantha'))).toBe('standard');
    expect(voiceQuality(v('Eddy', 'com.apple.eloquence.en-US.Eddy'))).toBe('novelty');
    expect(voiceQuality(v('Zarvox', 'com.apple.speech.synthesis.voice.Zarvox'))).toBe('novelty');
  });

  it('ranks premium over enhanced over standard over novelty; local, then the language, first', () => {
    const ranked = rankVoices(
      [
        v('Zarvox', 'com.apple.speech.synthesis.voice.Zarvox'),
        v('Samantha', 'com.apple.voice.compact.en-US.Samantha'),
        v('Ava', 'com.apple.voice.enhanced.en-US.Ava'),
        v('Zoe', 'com.apple.voice.premium.en-US.Zoe'),
        v('Remote', 'remote', { localService: false }),
        v('Thomas', 'com.apple.voice.premium.fr-FR.Thomas', { lang: 'fr-FR' }),
      ],
      'en-US',
    );
    expect(ranked.map((x) => x.name)).toEqual(['Zoe', 'Ava', 'Samantha', 'Zarvox']);
  });

  it('labels a tier only the URI carries, and lists best first', () => {
    voices = [
      v('Samantha', 'com.apple.voice.compact.en-US.Samantha'),
      v('Samantha', 'com.apple.voice.enhanced.en-US.Samantha'),
    ];
    expect(listVoices('en-US').map((o) => [o.id, o.label])).toEqual([
      ['com.apple.voice.enhanced.en-US.Samantha', 'Samantha (Enhanced)'],
      ['com.apple.voice.compact.en-US.Samantha', 'Samantha'],
    ]);
  });

  it('a saved voice is found by URI — two Samanthas are told apart — and a missing one falls back', () => {
    const list = [
      v('Samantha', 'com.apple.voice.compact.en-US.Samantha'),
      v('Samantha', 'com.apple.voice.enhanced.en-US.Samantha'),
    ];
    const compact = 'com.apple.voice.compact.en-US.Samantha';
    expect(pickVoice(list, 'en-US', compact)).toEqual({ voice: list[0], fallback: false });
    expect(pickVoice(list, 'en-US', 'com.apple.voice.premium.en-US.Zoe')).toEqual({
      voice: list[1],
      fallback: true,
    });
    expect(pickVoice(list, 'en-US', null)).toEqual({ voice: list[1], fallback: false });
  });
});
