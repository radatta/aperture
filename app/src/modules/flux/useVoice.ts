import { useCallback, useEffect, useRef, useState } from 'react';
import { readVoiceEnabled, readVoiceId, writeVoiceEnabled, writeVoiceId } from './prefs';
import type { Utterance } from './voice/cues';
import { createSpeaker, listVoices, type Speaker, type VoiceOption } from './voice/speaker';

// Voice cues for the Flux stage: on/off and the chosen voice are per device (voices differ per OS).
// Every method that can unlock speech must be called from a click handler — iOS only speaks after a
// gesture.
export interface VoiceControl {
  readonly on: boolean;
  // The saved voice's id (voiceURI), or null for Auto — the best installed (D58).
  readonly id: string | null;
  // Installed voices in the language, best first; voices[0] is what Auto speaks with.
  readonly voices: readonly VoiceOption[];
  // A saved voice that isn't on this device: Auto speaks instead, and the picker says so.
  readonly missing: boolean;
  // Inside the Start tap: unlock speech for this visit ("Voice on" the first time).
  prime(): void;
  speak(u: Utterance): void;
  cancel(): void;
  toggle(): void;
  change(id: string | null): void;
  // A tap: say the preview phrase in the current voice.
  preview(): void;
}

const UNLOCK = 'Voice on';
// The cue words the voice will actually say, so it's judged on them.
export const PREVIEW = 'Hold. One. Two. Set complete.';

const matches = (v: VoiceOption, id: string) => v.id === id || v.name === id;

export function useVoice(): VoiceControl {
  const [on, setOn] = useState(readVoiceEnabled);
  const [id, setId] = useState(readVoiceId);
  const [voices, setVoices] = useState<VoiceOption[]>(() => listVoices());
  const speakerRef = useRef<Speaker | null>(null);
  const onRef = useRef(on);
  onRef.current = on;
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    const load = () => setVoices(listVoices());
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, []);

  // Silence on leave — a cue mid-utterance shouldn't follow you to another page.
  useEffect(() => () => speakerRef.current?.cancel(), []);

  const speaker = useCallback(() => {
    speakerRef.current ??= createSpeaker({ voiceId: idRef.current });
    return speakerRef.current;
  }, []);

  const prime = useCallback(() => {
    if (onRef.current) speaker().prime(UNLOCK);
  }, [speaker]);

  const speak = useCallback(
    (u: Utterance) => {
      if (onRef.current) speaker().speak(u);
    },
    [speaker],
  );

  const cancel = useCallback(() => speakerRef.current?.cancel(), []);

  const toggle = useCallback(() => {
    const next = !onRef.current;
    onRef.current = next;
    setOn(next);
    writeVoiceEnabled(next);
    // This click is a gesture, so turning voice on can unlock speech right here.
    if (next) speaker().prime(UNLOCK);
    else speakerRef.current?.cancel();
  }, [speaker]);

  const preview = useCallback(() => {
    const s = speaker();
    s.prime();
    s.speak({ text: PREVIEW, priority: 'high' });
  }, [speaker]);

  const change = useCallback(
    (next: string | null) => {
      idRef.current = next;
      setId(next);
      writeVoiceId(next);
      // This change is a gesture — preview the new voice.
      speaker().setVoice(next);
      preview();
    },
    [speaker, preview],
  );

  // Only once voices have loaded: an empty list is "not yet", not "gone".
  const missing = id !== null && voices.length > 0 && !voices.some((v) => matches(v, id));
  return { on, id, voices, missing, prime, speak, cancel, toggle, change, preview };
}

// The picker's value: the saved voice's option id, or '' for Auto (also when the saved one is missing).
export const pickedId = (voice: Pick<VoiceControl, 'id' | 'voices'>): string =>
  (voice.id !== null && voice.voices.find((v) => matches(v, voice.id as string))?.id) || '';
