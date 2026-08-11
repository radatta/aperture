import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu } from './index';

function setup(onSelect = vi.fn()) {
  const user = userEvent.setup();
  render(
    <Menu
      items={[
        { label: 'Split…', onSelect },
        { label: 'Focus', onSelect: vi.fn() },
        { label: 'Drop task', tone: 'danger', onSelect: vi.fn() },
      ]}
    />,
  );
  return { user, onSelect, trigger: screen.getByRole('button', { name: 'More actions' }) };
}

describe('Menu', () => {
  it('is closed until asked, and reports that state to assistive tech', async () => {
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the chosen action and closes', async () => {
    const { user, onSelect, trigger } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Split…' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // role="menu" promises arrow-key navigation to screen readers, so it has to actually work.
  it('focuses the first item on open and moves with the arrow keys', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Split…' }));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Focus' }));

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Split…' }));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Drop task' }));
  });

  // These actions used to be plain in-row buttons; dismissing must not dump a keyboard user at the
  // top of the document.
  it('returns focus to the trigger on Escape', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger after selecting', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click without stealing focus back', async () => {
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });
});
