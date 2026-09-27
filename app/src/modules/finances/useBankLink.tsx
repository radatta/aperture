import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CreateLinkTokenInput, LinkSuccessMetadata } from '@aperture/shared';
import { useApi } from '../../data/api-context';
import { useCompletePlaidUpdate, useExchangePublicToken } from '../../data/hooks/useFinances';
import { FakeLinkDialog } from './FakeLinkDialog';
import { openPlaidLink } from './usePlaidLink';

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

// The whole connect/reconnect flow: link token → Link (real, or the stub's fake dialog) → exchange
// (connect) or completePlaidUpdate (update mode). Render `dialog` somewhere on the page.
export function useBankLink(): {
  start: (input: CreateLinkTokenInput) => void;
  busy: boolean;
  error: string | null;
  dialog: ReactNode;
} {
  const api = useApi();
  const exchange = useExchangePublicToken();
  const complete = useCompletePlaidUpdate();
  const [fakeFor, setFakeFor] = useState<CreateLinkTokenInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish(input: CreateLinkTokenInput, publicToken: string, md: LinkSuccessMetadata) {
    try {
      if (input.mode === 'update') await complete.mutateAsync(input.itemId);
      else
        await exchange.mutateAsync({
          publicToken,
          institution: {
            id: md.institution?.institution_id ?? '',
            name: md.institution?.name ?? 'Bank',
          },
          accounts: md.accounts,
        });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function start(input: CreateLinkTokenInput) {
    setError(null);
    setBusy(true);
    try {
      const { linkToken, environment } = await api.createPlaidLinkToken(input);
      if (environment === 'stub') {
        setFakeFor(input);
        return;
      }
      await openPlaidLink(linkToken, {
        onSuccess: (publicToken, md) => void finish(input, publicToken, md),
        onExit: (msg) => {
          setBusy(false);
          if (msg) setError(msg);
        },
      });
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  const dialog = (
    <FakeLinkDialog
      open={fakeFor !== null}
      onCancel={() => {
        setFakeFor(null);
        setBusy(false);
      }}
      onSuccess={(md) => {
        const input = fakeFor!;
        setFakeFor(null);
        void finish(input, 'public-stub', md);
      }}
    />
  );

  return { start: (input) => void start(input), busy, error, dialog };
}
