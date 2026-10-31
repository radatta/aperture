import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoicePicker } from './VoicePicker';
import type { VoiceControl } from './useVoice';
import type { VoiceOption } from './voice/speaker';

const ZOE: VoiceOption = {
  id: 'com.apple.voice.premium.en-US.Zoe',
  name: 'Zoe',
  lang: 'en-US',
  quality: 'premium',
  label: 'Zoe (Premium)',
};
const SAM: VoiceOption = {
  id: 'com.apple.voice.compact.en-US.Samantha',
  name: 'Samantha',
  lang: 'en-US',
  quality: 'standard',
  label: 'Samantha',
};

function voice(over: Partial<VoiceControl> = {}): VoiceControl {
  return {
    on: true,
    id: null,
    voices: [ZOE, SAM],
    missing: false,
    prime: vi.fn(),
    speak: vi.fn(),
    cancel: vi.fn(),
    toggle: vi.fn(),
    change: vi.fn(),
    preview: vi.fn(),
    ...over,
  };
}

const select = () => screen.getByLabelText('Voice') as HTMLSelectElement;
const options = () => [...select().options].map((o) => o.textContent);

describe('VoicePicker (D58)', () => {
  it('Auto names the voice it speaks with; the rest follow best first, labelled', () => {
    render(<VoicePicker voice={voice()} />);
    expect(options()).toEqual(['Auto — Zoe (Premium)', 'Zoe (Premium)', 'Samantha']);
    expect(select().value).toBe('');
  });

  it('shows the saved voice, found by URI or by its pre-D58 name', () => {
    const { unmount } = render(<VoicePicker voice={voice({ id: SAM.id })} />);
    expect(select().value).toBe(SAM.id);
    unmount();
    render(<VoicePicker voice={voice({ id: 'Samantha' })} />);
    expect(select().value).toBe(SAM.id);
  });

  it('picking one hands its id over; Auto hands null', async () => {
    const v = voice({ id: SAM.id });
    render(<VoicePicker voice={v} compact />);
    await userEvent.selectOptions(select(), ZOE.id);
    expect(v.change).toHaveBeenLastCalledWith(ZOE.id);
    await userEvent.selectOptions(select(), '');
    expect(v.change).toHaveBeenLastCalledWith(null);
  });

  it('a saved voice not on this device says so, and shows Auto — never a quiet swap', () => {
    render(
      <VoicePicker voice={voice({ id: 'com.apple.voice.premium.en-US.Ava', missing: true })} />,
    );
    expect(
      screen.getByText('Your saved voice isn’t on this device — using Zoe (Premium).'),
    ).toBeTruthy();
    expect(select().value).toBe('');
  });
});
