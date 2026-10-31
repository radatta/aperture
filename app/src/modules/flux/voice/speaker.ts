// Thin effectful shell around the Web Speech API (SpeechSynthesis). All cue logic lives in the pure
// cues.ts reducer; this just speaks. On-device only — we prefer localService (offline) voices so
// nothing hits the network, and the best of them (D58). No-ops safely where SpeechSynthesis is unavailable.
//
// Aperture: iOS only lets a page speak after a gesture (WebKit 223473), and a zero-length "unlock"
// utterance is folklore, so prime() speaks a short real phrase inside the gesture.

import type { Utterance } from './cues';

export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'novelty';

export interface VoiceOption {
  readonly id: string; // voiceURI — iOS can list a compact and an Enhanced voice under one name
  readonly name: string;
  readonly lang: string;
  readonly quality: VoiceQuality;
  readonly label: string; // the name, plus "(Enhanced)" / "(Premium)" when only the URI says so
}

type VoiceLike = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'> & {
  readonly voiceURI?: string;
  readonly default?: boolean;
};

const supported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Quality isn't in the API (D58), so read it off the URI and name, which carry it on Apple platforms:
// com.apple.voice.premium.en-US.Zoe, "Samantha (Enhanced)". Eloquence and the old speech-synthesis
// voices (Zarvox, Bells, Bahh…) are the novelty set — never an automatic pick.
export function voiceQuality(v: Pick<VoiceLike, 'name' | 'voiceURI'>): VoiceQuality {
  const id = `${v.voiceURI ?? ''} ${v.name}`.toLowerCase();
  if (id.includes('premium')) return 'premium';
  if (id.includes('enhanced')) return 'enhanced';
  if (id.includes('eloquence') || id.includes('com.apple.speech.synthesis.voice.'))
    return 'novelty';
  return 'standard';
}

const RANK: Record<VoiceQuality, number> = { premium: 3, enhanced: 2, standard: 1, novelty: 0 };

function option(v: VoiceLike): VoiceOption {
  const quality = voiceQuality(v);
  const tag = quality === 'premium' ? 'Premium' : quality === 'enhanced' ? 'Enhanced' : null;
  const label =
    tag && !v.name.toLowerCase().includes(tag.toLowerCase()) ? `${v.name} (${tag})` : v.name;
  return { id: v.voiceURI || v.name, name: v.name, lang: v.lang, quality, label };
}

// The voices worth offering, best first: local (offline) ones when there are any, in the page's
// language when any match, then by quality, the exact locale, the system default, and name.
export function rankVoices<V extends VoiceLike>(voices: readonly V[], lang: string): V[] {
  const local = voices.filter((v) => v.localService);
  const pool = local.length > 0 ? local : [...voices];
  const prefix = lang.slice(0, 2).toLowerCase();
  const inLang = pool.filter((v) => v.lang?.toLowerCase().startsWith(prefix));
  const exact = (v: V) => (v.lang?.toLowerCase() === lang.toLowerCase() ? 1 : 0);
  return (inLang.length > 0 ? inLang : pool).sort(
    (a, b) =>
      RANK[voiceQuality(b)] - RANK[voiceQuality(a)] ||
      exact(b) - exact(a) ||
      Number(b.default) - Number(a.default) ||
      a.name.localeCompare(b.name),
  );
}

// A saved voice (by URI, or by name from before D58) if it's one the picker offers, else the best — so
// what speaks always matches what the picker shows.
export function pickVoice<V extends VoiceLike>(
  voices: readonly V[],
  lang: string,
  preferred: string | null,
): { voice: V | null; fallback: boolean } {
  const ranked = rankVoices(voices, lang);
  const saved = preferred
    ? (ranked.find((v) => v.voiceURI === preferred) ?? ranked.find((v) => v.name === preferred))
    : undefined;
  if (saved) return { voice: saved, fallback: false };
  return { voice: ranked[0] ?? null, fallback: preferred !== null };
}

// The picker's voices, best first; [] where unsupported.
export function listVoices(lang = navigator.language): VoiceOption[] {
  if (!supported()) return [];
  return rankVoices(window.speechSynthesis.getVoices(), lang).map(option);
}

export interface Speaker {
  // Speak an utterance; "high" priority cancels any in-flight speech first, the rest queue.
  speak(u: Utterance): void;
  // Stop any in-flight speech.
  cancel(): void;
  // Call inside a user gesture to satisfy the gesture requirement. The first call that passes
  // `unlock` also speaks it, so the session is audibly unlocked while the gesture is still live.
  prime(unlock?: string): void;
  // Choose a voice by id (its voiceURI; null = the best installed).
  setVoice(id: string | null): void;
}

export function createSpeaker(
  opts: { rate?: number; lang?: string; voiceId?: string | null } = {},
): Speaker {
  const rate = opts.rate ?? 1.0;
  const lang = opts.lang ?? navigator.language;

  let preferred = opts.voiceId ?? null;
  let voice: SpeechSynthesisVoice | null = null;
  let resolvedFrom = -1; // how many voices were installed when the voice was last picked
  let unlocked = false;

  // iOS loads voices late, so a better one (or the saved one) can arrive after the first cue: pick again
  // whenever the installed count changes.
  function resolveVoice(): void {
    if (!supported()) return;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0 || voices.length === resolvedFrom) return;
    voice = pickVoice(voices, lang, preferred).voice;
    resolvedFrom = voices.length;
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
    setVoice(id: string | null) {
      preferred = id;
      voice = null;
      resolvedFrom = -1;
    },
    speak,
  };
}
