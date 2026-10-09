// Thin effectful shell around the Web Speech API (SpeechSynthesis). All cue logic lives in the pure
// cues.ts reducer; this just speaks. On-device only — we prefer localService (offline) voices so
// nothing hits the network. No-ops safely where SpeechSynthesis is unavailable.
//
// Aperture: iOS only lets a page speak after a gesture (WebKit 223473), and a zero-length "unlock"
// utterance is folklore, so prime() speaks a short real phrase inside the gesture.

import type { Utterance } from './cues';

export interface VoiceOption {
  readonly name: string;
  readonly lang: string;
}

const supported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Local (offline) voices available for the picker; [] where unsupported.
export function listLocalVoices(): VoiceOption[] {
  if (!supported()) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => v.localService)
    .map((v) => ({ name: v.name, lang: v.lang }));
}

export interface Speaker {
  // Speak an utterance; "high" priority cancels any in-flight speech first.
  speak(u: Utterance): void;
  // Stop any in-flight speech.
  cancel(): void;
  // Call inside a user gesture to satisfy the gesture requirement. The first call that passes
  // `unlock` also speaks it, so the session is audibly unlocked while the gesture is still live.
  prime(unlock?: string): void;
  // Choose a specific voice by name (null = auto-select).
  setVoice(name: string | null): void;
}

export function createSpeaker(
  opts: { rate?: number; lang?: string; voiceName?: string | null } = {},
): Speaker {
  const rate = opts.rate ?? 1.0;
  const lang = opts.lang ?? navigator.language;

  let preferredName = opts.voiceName ?? null;
  let voice: SpeechSynthesisVoice | null = null;
  let resolved = false;
  let unlocked = false;

  function resolveVoice(): void {
    if (resolved || !supported()) return;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return; // populated async on some engines — retry next call
    if (preferredName) {
      const chosen = voices.find((v) => v.name === preferredName);
      if (chosen) {
        voice = chosen;
        resolved = true;
        return;
      }
    }
    const local = voices.filter((v) => v.localService);
    const pool = local.length > 0 ? local : voices;
    const prefix = lang.slice(0, 2).toLowerCase();
    voice = pool.find((v) => v.lang?.toLowerCase().startsWith(prefix)) ?? pool[0] ?? null;
    resolved = true;
  }

  function speak(u: Utterance): void {
    if (!supported()) return;
    resolveVoice();
    if (u.priority === 'high') window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(u.text);
    utt.rate = rate;
    utt.lang = lang;
    if (voice) utt.voice = voice;
    window.speechSynthesis.speak(utt);
  }

  return {
    prime(unlock?: string) {
      if (!supported()) return;
      try {
        window.speechSynthesis.resume();
      } catch {
        // resume() can throw if nothing is queued — harmless
      }
      resolveVoice();
      if (unlock && !unlocked) {
        unlocked = true;
        speak({ text: unlock, priority: 'high' });
      }
    },
    cancel() {
      if (!supported()) return;
      window.speechSynthesis.cancel();
    },
    setVoice(name: string | null) {
      preferredName = name;
      voice = null;
      resolved = false;
    },
    speak,
  };
}
