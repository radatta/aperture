import { beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';
import { createStubClient } from '../data/stubClient';
import { setFluxEngineFactory } from '../modules/flux/engine/engine';
import { createFakeEngine } from '../modules/flux/engine/fakeEngine';

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

describe('dock: a route that hides capture', () => {
  it('keeps a running timer on the Flux stage while the capture bar goes', async () => {
    setFluxEngineFactory(() => createFakeEngine().engine);
    const api = createStubClient({ seed: false, storageKey: `shell-${Math.random()}` });
    await api.updateSettings({ fluxDisclaimerAckAt: 1 });
    const user = userEvent.setup();
    renderApp({ api, path: '/settings' });
    await user.click(await screen.findByTitle('Start a 25-minute focus block'));
    await user.click(screen.getByRole('link', { name: 'Flux' }));
    await user.click(await screen.findByText('Chin Tuck (Cervical Retraction)'));
    await screen.findByRole('button', { name: 'Start camera' });
    expect(screen.queryByRole('textbox', { name: 'Capture log' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('keeps a half-typed capture across the hidden stretch, and "/" leaves the hidden field alone', async () => {
    setFluxEngineFactory(() => createFakeEngine().engine);
    const api = createStubClient({ seed: false, storageKey: `shell-${Math.random()}` });
    await api.updateSettings({ fluxDisclaimerAckAt: 1 });
    const user = userEvent.setup();
    renderApp({ api, path: '/flux' });
    await user.type(await screen.findByRole('textbox', { name: 'Capture log' }), 'half a thought');
    await user.click(screen.getByText('Chin Tuck (Cervical Retraction)'));
    await screen.findByRole('button', { name: 'Start camera' });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('/');
    expect(document.activeElement).not.toBe(screen.getByLabelText('Capture log'));
    await user.click(screen.getByRole('link', { name: /All exercises/ }));
    const field = await screen.findByRole('textbox', { name: 'Capture log' });
    expect((field as HTMLTextAreaElement).value).toBe('half a thought');
  });
});

describe('a failed settings read', () => {
  it('shows the defaults notice with Retry; a pending one shows nothing', async () => {
    const user = userEvent.setup();
    const api = createStubClient({ seed: true, storageKey: `shell-${Math.random()}` });
    const real = api.getSettings.bind(api);
    let fail = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    api.getSettings = async () => {
      await gate;
      if (fail) throw new Error('getSettings failed (503)');
      return real();
    };
    renderApp({ api, path: '/habits' });
    await screen.findByLabelText('Capture log');
    expect(screen.queryByText(/running on defaults/)).toBeNull(); // still pending
    act(() => release());
    await screen.findByText(/Couldn.t load your settings — running on defaults/);
    fail = false;
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => expect(screen.queryByText(/running on defaults/)).toBeNull());
  });
});
