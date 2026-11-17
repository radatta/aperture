import { useEffect, useRef, useState } from 'react';
import {
  AUTH_HEADER,
  CAPTURE_SAY,
  SCOPED_TOKENS_MAX,
  scopedTokenNameError,
} from '@aperture/shared';
import type { ScopedTokenInfo } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { ChevronRightIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { fmtDateTime } from '../../lib/format';
import { useDisclosure } from '../../lib/useDisclosure';
import {
  useMintScopedToken,
  useRevokeScopedToken,
  useScopedTokens,
} from '../../data/hooks/useScopedTokens';
import { CopyField, TokenReveal } from './PlacesSection';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Couldn’t save — try again.');

// Settings › Capture (docs/areas/tasks/capture.md): the tokens a voice Shortcut or Raycast adds tasks with,
// and how to set the Shortcut up. One token per device, named, so revoking the phone's leaves the Mac's
// working. A token is good for POST /api/capture only — nothing else in Aperture.
export function CaptureTokensSection() {
  const listQ = useScopedTokens('capture');
  const tokens = listQ.data ?? [];
  // An empty list here would read as "no tokens" and invite minting a duplicate.
  const failed = listQ.isError && listQ.data === undefined;
  const [revealed, setRevealed] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Capture
      </Text>
      <Text size="sm" tone="muted">
        Add a task by voice — “Hey Siri, Aperture” or the Action Button — or from Raycast. Each
        device gets its own token; revoking one stops only that device. These aren’t the Places
        Shortcut token above, which only reads errand lists.
      </Text>
      {failed && (
        <LoadError onRetry={() => void listQ.refetch()}>Couldn’t load capture tokens.</LoadError>
      )}
      {revealed && (
        <TokenReveal
          token={revealed}
          onDone={() => setRevealed(null)}
          label="Capture token"
          where="the Shortcut’s header (or Raycast’s Keychain item)"
        />
      )}
      {listQ.data && tokens.length === 0 && (
        <Text size="sm" tone="muted">
          No capture tokens yet — make one for each device you’ll capture from.
        </Text>
      )}
      <div className="flex flex-col gap-2">
        {tokens.map((t) => (
          <TokenRow key={t.id} token={t} />
        ))}
      </div>
      <MintToken tokens={tokens} loaded={listQ.data !== undefined} onMinted={setRevealed} />
      <CaptureRecipe />
    </section>
  );
}

function MintToken({
  tokens,
  loaded,
  onMinted,
}: {
  tokens: ScopedTokenInfo[];
  loaded: boolean;
  onMinted: (token: string) => void;
}) {
  const mint = useMintScopedToken('capture');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const full = tokens.length >= SCOPED_TOKENS_MAX;
  // Said as you type (or at once when the list is full), never after a round trip.
  const problem = trimmed || full ? scopedTokenNameError(trimmed, tokens) : null;
  // The message renders under the field — with the field just above the bottom dock, behind it. Bring it
  // into view each time it changes, or a disabled Make token reads as doing nothing.
  const message = error ?? problem;
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) messageRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [message]);

  async function make() {
    // A second Enter while the first mint is out would mint a twin whose plaintext is never shown.
    if (!trimmed || problem || !loaded || mint.isPending) return;
    setError(null);
    try {
      const r = await mint.mutateAsync(trimmed);
      setName('');
      onMinted(r.token);
    } catch (e) {
      setError(errText(e)); // the typed name stays
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="New token for"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void make()}
          placeholder="iPhone, Raycast…"
          className="w-48"
        />
        <Button
          size="sm"
          aria-label="Make capture token"
          disabled={!trimmed || !!problem || !loaded || mint.isPending}
          onClick={() => void make()}
        >
          Make token
        </Button>
      </div>
      <div role="alert" ref={messageRef}>
        {message && (
          <Text as="p" size="xs" tone="danger" className="mt-2">
            {message}
          </Text>
        )}
      </div>
    </Card>
  );
}

function tokenLine(t: ScopedTokenInfo): string {
  return [
    `ends …${t.hint}`,
    `created ${fmtDateTime(t.createdAt)}`,
    t.lastUsedAt !== null ? `last used ${fmtDateTime(t.lastUsedAt)}` : 'never used',
    `${t.usedToday}\u00a0today`, // never "0" on one line and "today" on the next
  ].join('\u00a0· '); // a wrap never starts a line with the dot
}

function TokenRow({ token }: { token: ScopedTokenInfo }) {
  const revoke = useRevokeScopedToken('capture');
  const [confirm, setConfirm] = useState(false);
  return (
    <Card className="flex flex-col gap-2 px-3.5 py-2.5">
      {/* The name and Revoke share the first line; the details take the full width under them, so a
          phone never pushes Revoke onto a line of its own. */}
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <Text weight="medium" className="min-w-0 break-words">
            {token.name}
          </Text>
          {!confirm && (
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Revoke ${token.name}`}
              onClick={() => setConfirm(true)}
            >
              Revoke…
            </Button>
          )}
        </div>
        <Text size="xs" tone="muted" tabular>
          {tokenLine(token)}
        </Text>
      </div>
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <Text size="sm" tone="muted" className="basis-full">
            {token.name} stops adding tasks at once.
          </Text>
          <Button
            variant="gold"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(token.id)}
          >
            Revoke
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </div>
      )}
      <span role="alert" className="empty:hidden">
        {revoke.isError && (
          <Text size="xs" tone="danger">
            Couldn’t revoke — try again.
          </Text>
        )}
      </span>
    </Card>
  );
}

// The voice Shortcut, step by step. Every answer the route gives carries `say` — what was added, or what
// went wrong — so the Shortcut speaks it; an answer with none (a CloudFront error has no body) speaks the
// fallback. No capture ends silently. Full recipe and the Action Button: capture.md → The Shortcut.
const captureUrl = (origin: string) => `${origin}/api/capture`;

function CaptureRecipe() {
  const recipe = useDisclosure();
  return (
    <Card className="flex flex-col gap-3">
      <button
        type="button"
        ref={recipe.triggerRef}
        aria-expanded={recipe.open}
        onClick={recipe.open ? recipe.onClose : recipe.onOpen}
        className="flex items-center gap-1 self-start text-left text-ink"
      >
        <ChevronRightIcon size={14} className={cx('transition', recipe.open && 'rotate-90')} />
        <Text weight="medium">Set up the Siri Shortcut</Text>
      </button>
      {/* Each step's body is a div inside the <li>: a flex <li> stops being a list item and loses its
          number. */}
      {recipe.open && (
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-ink">
          <li>
            In Shortcuts, tap + and name the shortcut <b>Aperture</b> — that’s the word you’ll say
            to Siri.
          </li>
          <li>
            Add <b>Dictate Text</b> and set Stop Listening to <b>After Pause</b>.
          </li>
          <li>
            Add <b>Copy to Clipboard</b> with Dictated Text — if the network step fails, your words
            are still there to paste.
          </li>
          <li>
            <div className="flex flex-col gap-1.5">
              <span>
                Add <b>Get Contents of URL</b> with the URL below, Method <b>POST</b>.
              </span>
              <CopyField label="URL" value={captureUrl(window.location.origin)} />
              <span>
                Under Headers, add one: the key below, and the value <b>Bearer</b>, a space, then
                your token.
              </span>
              <CopyField label="Header key" value={AUTH_HEADER} />
              <span>
                Request Body <b>JSON</b>: a Text field <b>text</b> set to Dictated Text, and a
                Boolean field <b>voice</b> set to <b>True</b>.
              </span>
            </div>
          </li>
          <li>
            Add <b>Get Dictionary Value</b>: <b>say</b> from Contents of URL. Then <b>If</b>{' '}
            Dictionary Value <b>has any value</b>: <b>Speak Text</b> Dictionary Value.{' '}
            <b>Otherwise</b>: <b>Speak Text</b> “{CAPTURE_SAY.noAnswer}” End If.
          </li>
          <li>
            In the shortcut’s ⓘ, turn on <b>Allow Running When Locked</b> if it’s offered. Then
            Settings › Action Button › <b>Shortcut</b> → Aperture.
          </li>
          <li className="text-ink-muted">
            Say “Hey Siri, Aperture”, wait for the prompt, then the task — “call the dentist at 5”.
            A time already past rolls to its next turn, and Siri says the day it landed on.
          </li>
        </ol>
      )}
    </Card>
  );
}
