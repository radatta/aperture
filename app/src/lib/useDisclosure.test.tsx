import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDisclosure } from './useDisclosure';

function Harness() {
  const d = useDisclosure();
  return d.open ? (
    <button onClick={d.onClose}>Close</button>
  ) : (
    <button ref={d.triggerRef} onClick={d.onOpen}>
      Open
    </button>
  );
}

describe('useDisclosure focus return', () => {
  it('hands focus back without the ring after a mouse close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('data-focus-quiet')).toBe(true);

    await user.tab(); // keyboard use takes the ring back
    expect(trigger.hasAttribute('data-focus-quiet')).toBe(false);
  });

  it('stays quiet after a mouse user closes with Esc-like keys (typing is not navigation)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    screen.getByRole('button', { name: 'Close' }).focus();
    await user.keyboard('{Enter}'); // a key, but not Tab

    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('data-focus-quiet')).toBe(true);
  });

  it('keeps the ring for a keyboard (Tab) navigator', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab(); // Tab onto Open
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Close' }).focus();
    await user.keyboard('{Enter}');

    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('data-focus-quiet')).toBe(false);
  });
});
