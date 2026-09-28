import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStandalonePwa, loadPlaidScript, openPlaidLink } from './usePlaidLink';

const scripts = () => document.head.querySelectorAll('script[src*="cdn.plaid.com"]');

afterEach(() => {
  scripts().forEach((s) => s.remove());
  delete window.Plaid;
});

describe('Plaid Link loader', () => {
  it('injects the CDN script at most once, however many callers race', async () => {
    const a = loadPlaidScript();
    const b = loadPlaidScript();
    expect(scripts()).toHaveLength(1);
    scripts()[0]!.dispatchEvent(new Event('load'));
    await Promise.all([a, b]);
    expect(scripts()).toHaveLength(1);
  });

  it('forgets a failed load so the next try injects again', async () => {
    const a = loadPlaidScript();
    scripts()[0]!.dispatchEvent(new Event('error'));
    await expect(a).rejects.toThrow(/Couldn’t load Plaid/);
    expect(scripts()).toHaveLength(0);
    void loadPlaidScript();
    expect(scripts()).toHaveLength(1);
  });

  it('opens Link and destroys the handler on success', async () => {
    const handler = { open: vi.fn(), destroy: vi.fn() };
    let config: Parameters<NonNullable<typeof window.Plaid>['create']>[0] | undefined;
    window.Plaid = { create: (c) => ((config = c), handler) };
    const onSuccess = vi.fn();
    await openPlaidLink('link-token', { onSuccess, onExit: vi.fn() });
    expect(handler.open).toHaveBeenCalled();
    config!.onSuccess('public-x', { institution: null, accounts: [] });
    expect(onSuccess).toHaveBeenCalledWith('public-x', { institution: null, accounts: [] });
    expect(handler.destroy).toHaveBeenCalled();
  });

  it('detects an installed PWA', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(display-mode: standalone)' })) as never;
    expect(isStandalonePwa()).toBe(true);
    window.matchMedia = original;
  });
});
