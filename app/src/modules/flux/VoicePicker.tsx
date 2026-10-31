import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { pickedId, type VoiceControl } from './useVoice';

// The voice picker (D58), on the stage and in Settings: installed voices best first, Auto naming what it
// speaks with, and a saved voice that isn't on this device said out loud on screen — never a quiet swap.
export function VoicePicker({ voice, compact }: { voice: VoiceControl; compact?: boolean }) {
  const auto = voice.voices[0];
  return (
    <div className={compact ? 'flex flex-col items-end gap-1' : 'flex flex-col gap-1'}>
      <Select
        {...(compact ? { 'aria-label': 'Voice' } : { label: 'Voice' })}
        title="Pick the voice (previews on change)"
        placeholder={auto ? `Auto — ${auto.label}` : 'Auto'}
        value={pickedId(voice)}
        onChange={(e) => voice.change(e.target.value || null)}
        options={voice.voices.map((v) => ({ value: v.id, label: v.label }))}
        className={compact ? 'max-w-[12rem] py-1 text-xs' : undefined}
      />
      {voice.missing && (
        <Text size="xs" tone="gold">
          Your saved voice isn’t on this device — using {auto?.label ?? 'the default'}.
        </Text>
      )}
    </div>
  );
}
