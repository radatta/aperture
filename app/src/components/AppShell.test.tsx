import { beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

beforeEach(() => globalThis.localStorage?.clear());

describe('dock height', () => {
  it('is published as --dock-h for the root scroll-padding', async () => {
    renderApp({ path: '/settings' });
    await screen.findByLabelText('Capture log');
    expect(document.documentElement.style.getPropertyValue('--dock-h')).toMatch(/^\d+px$/);
  });
});

describe('dock: idle Focus', () => {
  it('sits inside the capture panel while idle, and hands over to the timer row once started', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings' });

    const focus = await screen.findByTitle('Start a 25-minute focus block');
    // Inside the capture panel (the element holding the capture field), not a floating row above it.
    const panel = screen.getByLabelText('Capture log').closest('.rounded-2xl');
    expect(panel?.contains(focus)).toBe(true);

    await user.click(focus);
    await waitFor(() => expect(screen.queryByTitle('Start a 25-minute focus block')).toBeNull());
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});

describe('dock: on-screen keyboard', () => {
  it('lifts above the keyboard while capture has focus', async () => {
    const root = document.documentElement;
    const originalVv = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const originalClient = Object.getOwnPropertyDescriptor(root, 'clientHeight');
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 844 });
    try {
      renderApp({ path: '/settings' });
      const field = await screen.findByLabelText('Capture log');
      const dock = document.querySelector<HTMLElement>('[data-dock]')!;
      expect(dock.className).toContain('pb-safe');

      act(() => field.focus());
      act(() => {
        vv.height = 450; // keyboard + form bar
        vv.dispatchEvent(new Event('resize'));
      });
      expect(dock.style.bottom).toBe('394px');
      expect(dock.className).not.toContain('pb-safe');
    } finally {
      if (originalVv) Object.defineProperty(window, 'visualViewport', originalVv);
      else delete (window as { visualViewport?: unknown }).visualViewport;
      if (originalClient) Object.defineProperty(root, 'clientHeight', originalClient);
      else delete (root as { clientHeight?: unknown }).clientHeight;
    }
  });
});
