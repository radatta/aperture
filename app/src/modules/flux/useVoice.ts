import { useCallback, useEffect, useRef, useState } from 'react';
import { readVoiceEnabled, readVoiceName, writeVoiceEnabled, writeVoiceName } from './prefs';
import type { Utterance } from './voice/cues';
import { createSpeaker, listLocalVoices, type Speaker, type VoiceOption } from './voice/speaker';

// Voice cues for the Flux stage: on/off and the chosen voice are per device (voices differ per OS).
// Every method that can unlock speech must be called from a click handler — iOS only speaks after a
// gesture.
export interface VoiceControl {
  readonly on: boolean;
  readonly name: string | null;
  readonly voices: readonly VoiceOption[];
  // Inside the Start tap: unlock speech for this visit ("Voice on" the first time).
  prime(): void;
  speak(u: Utterance): void;
  cancel(): void;
  toggle(): void;
  change(name: string | null): void;
}

const UNLOCK = 'Voice on';

export function useVoice(): VoiceControl {
  const [on, setOn] = useState(readVoiceEnabled);
  const [name, setName] = useState(readVoiceName);
  const [voices, setVoices] = useState<VoiceOption[]>(listLocalVoices);
  const speakerRef = useRef<Speaker | null>(null);
  const onRef = useRef(on);
  onRef.current = on;
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const load = () => setVoices(listLocalVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  // Silence on leave — a cue mid-utterance shouldn't follow you to another page.
  useEffect(() => () => speakerRef.current?.cancel(), []);

  const speaker = useCallback(() => {
    speakerRef.current ??= createSpeaker({ voiceName: nameRef.current });
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

  const change = useCallback(
    (next: string | null) => {
      setName(next);
      writeVoiceName(next);
      // This change is a gesture — prime and preview the new voice.
      const s = speaker();
      s.setVoice(next);
      s.prime();
      s.speak({ text: 'Good, full range', priority: 'high' });
    },
    [speaker],
  );

  return { on, name, voices, prime, speak, cancel, toggle, change };
}
