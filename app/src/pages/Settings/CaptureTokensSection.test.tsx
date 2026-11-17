import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTH_HEADER, CAPTURE_SAY, SCOPED_TOKENS_MAX } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderWithProviders } from '../../test/utils';
import { CaptureTokensSection } from './CaptureTokensSection';

beforeEach(() => globalThis.localStorage?.clear());

const stub = () => createStubClient({ seed: false, storageKey: `capture-${Math.random()}` });

describe('Settings › Capture: tokens', () => {
  it('starts empty with an invitation', async () => {
    renderWithProviders(<CaptureTokensSection />, { api: stub() });
    await screen.findByText(/No capture tokens yet/);
    expect(screen.queryByLabelText('Capture token')).toBeNull();
  });

  it('makes a named token, shows it once with Copy, then lists only its hint', async () => {
    const api = stub();
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api });
    await screen.findByText(/No capture tokens yet/);
    await user.type(screen.getByLabelText('New token for'), 'iPhone');
    await user.click(screen.getByRole('button', { name: 'Make capture token' }));

    const field = await screen.findByLabelText<HTMLInputElement>('Capture token');
    expect(field.value).toMatch(/^apc_[A-Za-z0-9_-]{43}$/);
    const [info] = await api.listScopedTokens('capture');
    expect(info!.name).toBe('iPhone');
    expect(screen.getByText(new RegExp(`ends …${info!.hint}`))).toBeTruthy();
    expect(screen.getByText(/never used · 0 today/)).toBeTruthy();
    expect((screen.getByLabelText('New token for') as HTMLInputElement).value).toBe('');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Capture token')).toBeNull();
    // The plaintext is gone from the page; only the hint stays.
    expect(document.body.textContent).not.toContain(field.value);
  });

  it('refuses a clashing name and a full list as you type, before sending', async () => {
    const api = stub();
    await api.mintScopedToken('capture', 'iPhone');
    const mint = vi.spyOn(api, 'mintScopedToken');
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api });
    await screen.findByText('iPhone');
    await user.type(screen.getByLabelText('New token for'), 'iphone');
    expect(screen.getByText('Another token is already called "iphone"')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Make capture token' }).disabled,
    ).toBe(true);
    expect(mint).not.toHaveBeenCalled();

    for (let i = 1; i < SCOPED_TOKENS_MAX; i++) await api.mintScopedToken('capture', `t${i}`);
    renderWithProviders(<CaptureTokensSection />, { api });
    expect(
      await screen.findByText(`At most ${SCOPED_TOKENS_MAX} tokens — revoke one first`),
    ).toBeTruthy();
  });

  it('a refused mint says why and keeps the typed name', async () => {
    const api = stub();
    vi.spyOn(api, 'mintScopedToken').mockRejectedValueOnce(new Error('mintScopedToken failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api });
    await screen.findByText(/No capture tokens yet/);
    await user.type(screen.getByLabelText('New token for'), 'iPhone');
    await user.click(screen.getByRole('button', { name: 'Make capture token' }));
    expect(await screen.findByText('mintScopedToken failed (503)')).toBeTruthy();
    expect((screen.getByLabelText('New token for') as HTMLInputElement).value).toBe('iPhone');
    expect(screen.queryByLabelText('Capture token')).toBeNull();
  });

  it('revoke asks first; Cancel keeps it, Revoke removes only that one', async () => {
    const api = stub();
    await api.mintScopedToken('capture', 'iPhone');
    await api.mintScopedToken('capture', 'Raycast');
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Revoke iPhone' }));
    expect(screen.getByText('iPhone stops adding tasks at once.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((await api.listScopedTokens('capture')).length).toBe(2);

    await user.click(screen.getByRole('button', { name: 'Revoke iPhone' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('iPhone')).toBeNull());
    expect((await api.listScopedTokens('capture')).map((t) => t.name)).toEqual(['Raycast']);
    expect(screen.getByText('Raycast')).toBeTruthy();
  });

  it('a failed revoke says so and keeps the token listed', async () => {
    const api = stub();
    await api.mintScopedToken('capture', 'iPhone');
    vi.spyOn(api, 'revokeScopedToken').mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Revoke iPhone' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Couldn’t revoke — try again.')).toBeTruthy();
    expect(screen.getByText('iPhone')).toBeTruthy();
  });

  it('a failed list read says so with Retry and offers no mint', async () => {
    const api = stub();
    vi.spyOn(api, 'listScopedTokens').mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api });
    expect(await screen.findByText('Couldn’t load capture tokens.')).toBeTruthy();
    expect(screen.queryByText(/No capture tokens yet/)).toBeNull();
    await user.type(screen.getByLabelText('New token for'), 'iPhone');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Make capture token' }).disabled,
    ).toBe(true);
  });
});

describe('Settings › Capture: the Shortcut recipe', () => {
  it('opens to this origin’s capture URL, the header and the spoken fallback', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CaptureTokensSection />, { api: stub() });
    await user.click(await screen.findByRole('button', { name: 'Set up the Siri Shortcut' }));
    const steps = screen.getByRole('list');
    expect(within(steps).getByText(`${window.location.origin}/api/capture`)).toBeTruthy();
    expect(within(steps).getByText(AUTH_HEADER)).toBeTruthy();
    expect(steps.textContent).toContain(CAPTURE_SAY.noAnswer);
    expect(steps.textContent).toContain('Allow Running When Locked');
  });
});
