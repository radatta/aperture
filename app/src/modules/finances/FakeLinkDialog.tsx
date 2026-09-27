import { useState } from 'react';
import { FIXTURE_INSTITUTION, FIXTURE_LINK_ACCOUNTS } from '@aperture/shared';
import type { LinkSuccessMetadata } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';

// The stub's stand-in for Plaid Link (environment 'stub'): pick which fixture accounts to share, then
// hand back the same metadata shape real Link's onSuccess does. The rest of the flow — exchange,
// duplicate guard, first sync — runs exactly as it would against Plaid.
export function FakeLinkDialog({
  open,
  onSuccess,
  onCancel,
}: {
  open: boolean;
  onSuccess: (metadata: LinkSuccessMetadata) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState(() => new Set(FIXTURE_LINK_ACCOUNTS.map((a) => a.id)));
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal open={open} onClose={onCancel} label="Connect a bank (stub)">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Text as="h2" size="lg" weight="semibold">
            {FIXTURE_INSTITUTION.name}
          </Text>
          <Text size="sm" tone="muted">
            Stub Link — no real bank. Pick the accounts to share, like Plaid&apos;s account screen.
          </Text>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Accounts to share</legend>
          {FIXTURE_LINK_ACCOUNTS.map((a) => (
            <label
              key={a.id}
              className="flex items-center gap-3 rounded-xl border border-line px-3 py-2"
            >
              <input
                type="checkbox"
                checked={picked.has(a.id)}
                onChange={() => toggle(a.id)}
                className="accent-teal"
              />
              <Text size="sm">{a.name}</Text>
              <Text size="sm" tone="muted">
                ••{a.mask} · {a.subtype}
              </Text>
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() =>
              onSuccess({
                institution: {
                  institution_id: FIXTURE_INSTITUTION.id,
                  name: FIXTURE_INSTITUTION.name,
                },
                accounts: FIXTURE_LINK_ACCOUNTS.filter((a) => picked.has(a.id)),
              })
            }
          >
            Continue
          </Button>
        </div>
      </div>
    </Modal>
  );
}
