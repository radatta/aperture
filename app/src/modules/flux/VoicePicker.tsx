import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { pickedId, type VoiceControl } from './useVoice';

// The voice picker (D58), on the stage and in Settings: installed voices best first, Auto naming what it
// speaks with, and a saved voice that isn't on this device said out loud on screen — never a quiet swap.
export function VoicePicker({ voice, compact }: { voice: VoiceControl; compact?: boolean }) {
  const auto = voice.voices[0];
  return (
    <div className={cx('flex flex-col items-start gap-1', compact && 'sm:items-end')}>
      <Select
        {...(compact ? { 'aria-label': 'Voice' } : { label: 'Voice' })}
        title="Pick the voice (previews on change)"
        placeholder={auto ? `Auto — ${auto.label}` : 'Auto'}
        value={pickedId(voice)}
        onChange={(e) => voice.change(e.target.value || null)}
        options={voice.voices.map((v) => ({ value: v.id, label: v.label }))}
        className={compact ? 'max-w-full py-1 text-xs sm:max-w-[16rem]' : undefined}
      />
      {voice.missing && (
        <div className="flex flex-wrap items-center gap-x-2">
          <Text size="xs" tone="gold">
            Your saved voice isn’t on this device — using {auto?.label ?? 'the default'}.
          </Text>
          {/* The select already reads Auto, so choosing it again fires nothing: this clears the saved one. */}
          <Button variant="ghost" size="sm" onClick={() => voice.change(null)}>
            Use Auto
          </Button>
        </div>
      )}
    </div>
  );
}
