import { useEffect, useId, useRef, useState } from 'react';
import {
  AUTH_HEADER,
  PLACE_TOKEN_RACE_ERROR,
  placeError,
  placeTasks,
  slugify,
} from '@aperture/shared';
import type { Place, PlaceTokenStatus } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { LoadError } from '../../components/LoadError';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { ChevronRightIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { fmtDateTime } from '../../lib/format';
import { useDisclosure } from '../../lib/useDisclosure';
import {
  useDeletePlace,
  usePlaceDigest,
  usePlaces,
  usePlaceTokenStatus,
  useRevokePlaceToken,
  useRotatePlaceToken,
  useUpsertPlace,
} from '../../data/hooks/usePlaces';
import { useAllTasks } from '../../data/hooks/useTasks';

// The field look the Categories rows use: a faint resting border, full box on focus. No text size — every
// field keeps the 16px base, or iOS Safari zooms the page on focus.
const ROW_INPUT =
  'rounded-lg border border-line/60 bg-transparent px-2 py-1.5 text-ink outline-none transition hover:border-line-strong focus:border-teal focus:bg-surface';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Couldn’t save — try again.');

// Settings › Places (docs/areas/tasks/places.md): the stores you run errands at, the token the iPhone
// Shortcut reads them with, and how to set that Shortcut up. A place's link word (slug) is what `@word`
// in the capture bar and the Shortcut's URL use, so editing it moves its errands with it; deleting one
// asks where its errands go.
export function PlacesSection() {
  const placesQ = usePlaces();
  const places = placesQ.data ?? [];
  // An empty list here would read as "no places" and invite re-adding them.
  const failed = placesQ.isError && placesQ.data === undefined;

  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Places
      </Text>
      <Text size="sm" tone="muted">
        Errand lists by store. Put a task on one with “ | @” and its link word in the bar; your
        iPhone reads the list out when you arrive.
      </Text>
      {failed && (
        <LoadError onRetry={() => void placesQ.refetch()}>Couldn’t load places.</LoadError>
      )}
      {placesQ.data && places.length === 0 && (
        <Text size="sm" tone="muted">
          No places yet — add the stores you run errands at.
        </Text>
      )}
      <div className="flex flex-col gap-2">
        {places.map((p) => (
          <PlaceRow key={p.id} place={p} places={places} />
        ))}
      </div>
      <AddPlace places={places} loaded={placesQ.data !== undefined} />
      <TokenCard />
      <ShortcutRecipe places={places} />
    </section>
  );
}

function AddPlace({ places, loaded }: { places: Place[]; loaded: boolean }) {
  const upsert = useUpsertPlace();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const slug = slugify(trimmed);
  // Said as you type, so a clash or an all-symbols name never waits for a round trip.
  const problem = trimmed ? placeError(trimmed, slug, places) : null;

  async function add() {
    if (!trimmed || problem || !loaded) return;
    setError(null);
    try {
      await upsert.mutateAsync({ name: trimmed });
      setName('');
    } catch (e) {
      setError(errText(e)); // the typed name stays
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="New place"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="Store name"
          className="w-48"
        />
        <Button
          size="sm"
          aria-label="Add place"
          disabled={!trimmed || !!problem || !loaded || upsert.isPending}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      {(problem || error) && (
        <Text as="p" size="xs" tone="danger" className="mt-2">
          {error ?? problem}
        </Text>
      )}
      {trimmed && !problem && !error && (
        <Text as="p" size="xs" tone="muted" className="mt-2">
          Link word: @{slug}
        </Text>
      )}
    </Card>
  );
}

type RowPanel = null | 'test' | 'delete';

function PlaceRow({ place, places }: { place: Place; places: Place[] }) {
  const upsert = useUpsertPlace();
  const del = useDeletePlace();
  const tasksQ = useAllTasks();
  const [panel, setPanel] = useState<RowPanel>(null);
  const [name, setName] = useState(place.name);
  const [slug, setSlug] = useState(place.slug);
  const [error, setError] = useState<string | null>(null);
  const others = places.filter((p) => p.id !== place.id);
  // Unknown while the task list hasn't loaded — then the delete still asks, never claims "nothing on it".
  const open = tasksQ.data ? placeTasks(place.slug, tasksQ.data).length : null;

  // A change from elsewhere (the other field's save, another device) reseeds a field you haven't touched.
  const [prev, setPrev] = useState(place);
  if (prev !== place) {
    setPrev(place);
    if (name === prev.name) setName(place.name);
    if (slug === prev.slug) setSlug(place.slug);
  }

  // Either field's blur sends both as they stand now, and the row's saves run one after another — a later
  // save never lands before an earlier one, so a link-word edit can't be undone by a stale copy still on
  // its way. Each compares against what the server last said (`known`: the place as loaded, or the last
  // save's answer). The error is the last attempt's: unchanged (put back) or saved clears it.
  const known = useRef(place);
  useEffect(() => {
    known.current = place;
  }, [place]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  function save() {
    const next = { name: name.trim(), slug: slug.trim() };
    queue.current = queue.current.then(async () => {
      setError(null);
      if (next.name === known.current.name && next.slug === known.current.slug) return;
      try {
        known.current = await upsert.mutateAsync({ id: place.id, ...next });
      } catch (e) {
        setError(errText(e)); // what you typed stays, so you can fix it
      }
    });
    return queue.current;
  }

  return (
    <Card className="px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            // An emptied name goes through too: the refusal ("needs a name") shows, never a quiet no-op.
            onBlur={() => void save()}
            aria-label={`Rename ${place.name}`}
            className={cx(ROW_INPUT, 'w-40')}
          />
          <label className="flex items-center gap-0.5 text-ink-muted">
            <span aria-hidden>@</span>
            <input
              value={slug}
              // Link words are lowercase; typing "TJ" means tj.
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              onBlur={() => void save()}
              aria-label={`Link word for ${place.name}`}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={cx(ROW_INPUT, 'w-32')}
            />
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={panel === 'test'}
            aria-label={`Test ${place.name}`}
            onClick={() => setPanel(panel === 'test' ? null : 'test')}
          >
            Test
          </Button>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Delete ${place.name}`}
            onClick={() => setPanel(panel === 'delete' ? null : 'delete')}
          >
            Delete…
          </Button>
        </div>
      </div>
      <Text as="p" size="xs" tone="muted" className="mt-1.5">
        {open === null ? '' : `${open} open ${open === 1 ? 'errand' : 'errands'} · `}
        {place.lastReadAt
          ? `Shortcut last called ${fmtDateTime(place.lastReadAt)}`
          : 'Shortcut never called'}
      </Text>
      {error && (
        <Text as="p" size="xs" tone="danger" className="mt-1.5">
          {error}
        </Text>
      )}

      {panel === 'test' && <TestPanel slug={place.slug} />}

      {panel === 'delete' && (
        <DeletePanel
          place={place}
          others={others}
          open={open}
          pending={del.isPending}
          failed={del.isError}
          onDelete={(to) =>
            del.mutate({ id: place.id, reassignToSlug: to }, { onSuccess: () => setPanel(null) })
          }
          onCancel={() => setPanel(null)}
        />
      )}
    </Card>
  );
}

// What the Shortcut would show for this place right now — the same digest, read on demand.
function TestPanel({ slug }: { slug: string }) {
  const digest = usePlaceDigest(slug);
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      {digest.isError && !digest.data ? (
        <LoadError size="xs" onRetry={() => void digest.refetch()}>
          Couldn’t read this list.
        </LoadError>
      ) : !digest.data ? (
        <Text size="sm" tone="muted">
          Reading…
        </Text>
      ) : digest.data.count === 0 ? (
        <Text size="sm" tone="muted">
          Nothing on the list — the Shortcut stays quiet.
        </Text>
      ) : (
        <>
          <Text size="xs" tone="muted">
            The notification would read:
          </Text>
          <Text size="sm">{digest.data.text}</Text>
        </>
      )}
    </div>
  );
}

function DeletePanel({
  place,
  others,
  open,
  pending,
  failed,
  onDelete,
  onCancel,
}: {
  place: Place;
  others: Place[];
  open: number | null;
  pending: boolean;
  failed: boolean;
  onDelete: (reassignToSlug: string | null) => void;
  onCancel: () => void;
}) {
  // '' = off any list. Asked, never assumed: deleting a store shouldn't quietly drop its errands.
  const [to, setTo] = useState('');
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      {open === 0 ? (
        <Text size="sm" tone="muted">
          Delete {place.name}? Nothing is on its list.
        </Text>
      ) : (
        <Select
          label={
            open === null
              ? 'Move its errands to'
              : `Move its ${open} ${open === 1 ? 'errand' : 'errands'} to`
          }
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="No place"
          options={others.map((p) => ({ value: p.slug, label: p.name }))}
          className="w-48"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="gold" size="sm" disabled={pending} onClick={() => onDelete(to || null)}>
          Delete
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {failed && (
          <Text size="xs" tone="danger">
            Couldn’t delete — try again.
          </Text>
        )}
      </div>
    </div>
  );
}

function tokenLine(s: PlaceTokenStatus): string {
  if (!s.active) return 'No token yet — the Shortcut can’t read your lists until you generate one.';
  return [
    `Active · ends …${s.hint}`,
    s.createdAt !== null ? `created ${fmtDateTime(s.createdAt)}` : null,
    s.lastUsedAt !== null ? `last used ${fmtDateTime(s.lastUsedAt)}` : 'never used',
    `${s.readsToday} ${s.readsToday === 1 ? 'read' : 'reads'} today`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// The one token the Shortcut sends. Generated here, shown once (the server keeps only its hash), rotated
// or revoked here. A failed status read disables the buttons — rotating blind could break a working setup.
function TokenCard() {
  const statusQ = usePlaceTokenStatus();
  const rotate = useRotatePlaceToken();
  const revoke = useRevokePlaceToken();
  const [confirm, setConfirm] = useState<null | 'rotate' | 'revoke'>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const s = statusQ.data;
  const failed = statusQ.isError && !s;
  const busy = rotate.isPending || revoke.isPending;
  const failure = rotate.error ?? revoke.error;
  const raced = failure instanceof Error && failure.message.includes(PLACE_TOKEN_RACE_ERROR);

  function mint() {
    setConfirm(null);
    rotate.mutate(undefined, { onSuccess: (r) => setRevealed(r.token) });
  }
  function drop() {
    revoke.mutate(undefined, {
      onSuccess: () => {
        setConfirm(null);
        setRevealed(null);
      },
    });
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Text weight="medium">Shortcut token</Text>
        {failed ? (
          <LoadError size="xs" onRetry={() => void statusQ.refetch()}>
            Couldn’t load the token’s status.
          </LoadError>
        ) : (
          <Text size="sm" tone="muted" tabular>
            {s ? tokenLine(s) : 'Loading…'}
          </Text>
        )}
      </div>

      {revealed && <TokenReveal token={revealed} onDone={() => setRevealed(null)} />}

      {confirm === 'rotate' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <Text size="sm" tone="muted">
            The Shortcut stops working until you paste the new token into it.
          </Text>
          <Button size="sm" disabled={busy} onClick={mint}>
            Rotate
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      )}
      {confirm === 'revoke' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <Text size="sm" tone="muted">
            The Shortcut stops working until you generate a new token.
          </Text>
          <Button variant="gold" size="sm" disabled={busy} onClick={drop}>
            Revoke
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* While a confirm is open its own buttons are the choice; the triggers step aside. */}
        {confirm ? null : s?.active ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm('rotate')}>
              Rotate…
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => setConfirm('revoke')}>
              Revoke…
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={!s || busy} onClick={mint}>
            Generate token
          </Button>
        )}
        <span role="alert">
          {(rotate.isError || revoke.isError) && (
            <Text size="xs" tone="danger">
              {/* Lost to the same call on another device: the status above has refetched — say why. */}
              {raced
                ? PLACE_TOKEN_RACE_ERROR
                : rotate.isError
                  ? 'Couldn’t make a token — try again.'
                  : 'Couldn’t revoke — try again.'}
            </Text>
          )}
        </span>
      </div>
    </Card>
  );
}

// The plaintext, once. Copy goes through the clipboard; where that's refused, the field is selectable.
function TokenReveal({ token, onDone }: { token: string; onDone: () => void }) {
  const [copy, setCopy] = useState<null | 'copied' | 'failed'>(null);
  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-teal bg-surface p-3">
      <Text size="sm">
        Your new token — shown this once. Paste it into the Shortcut’s header now; Aperture keeps
        only a fingerprint of it.
      </Text>
      <input
        readOnly
        value={token}
        aria-label="Shortcut token"
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-ink outline-none focus:border-teal"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void copyToken()}>
          Copy
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
        <span role="status">
          {copy && (
            <Text size="xs" tone={copy === 'copied' ? 'teal' : 'danger'}>
              {copy === 'copied'
                ? 'Copied'
                : 'Couldn’t copy — select the token above and copy it by hand.'}
            </Text>
          )}
        </span>
      </div>
    </div>
  );
}

// One generic Shortcut holds the URL and the token and takes the store's link word as its input; each
// store's Arrive automation only runs it. A rotated token is pasted once, into that one Shortcut. Every
// answer the route gives carries `text` — the list, or what went wrong, '' when there's nothing to buy — so
// the Shortcut's rule is "show text if it has any value", and an answer with no `count` either (not the
// route's: a CloudFront 5xx or throttle) says Aperture didn't answer. No failure is silent on the phone.
const SHORTCUT_INPUT = '[Shortcut Input]';
// Shown when the answer carries neither `text` nor `count` — a CloudFront 5xx or throttle has no body.
const NO_ANSWER = 'Aperture didn’t answer';
const shortcutUrlTemplate = (origin: string) => `${origin}/api/places/${SHORTCUT_INPUT}/tasks`;

function ShortcutRecipe({ places }: { places: Place[] }) {
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
        <Text weight="medium">Set up the iPhone Shortcut</Text>
      </button>
      {/* Each step's body is a div inside the <li>: a flex <li> stops being a list item and loses its
          number. */}
      {recipe.open && (
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-ink">
          <li>
            In Shortcuts, tap + and name the shortcut <b>Aperture list</b>. Tap ⓘ and let it receive{' '}
            <b>Text</b> input — each store’s automation hands it that store’s link word.
          </li>
          <li>
            <div className="flex flex-col gap-1.5">
              <span>
                Add <b>Get Contents of URL</b> with the URL below, Method <b>GET</b>. Where it says{' '}
                <b>{SHORTCUT_INPUT}</b>, put the <b>Shortcut Input</b> variable instead (delete that
                part, then pick Shortcut Input from the variables above the keyboard) — that’s where
                the store’s link word goes.
              </span>
              <CopyField label="URL" value={shortcutUrlTemplate(window.location.origin)} />
              <span>
                Under Headers, add one: the key below, and the value <b>Bearer</b>, a space, then
                your token (from the card above).
              </span>
              <CopyField label="Header key" value={AUTH_HEADER} />
            </div>
          </li>
          <li>
            Add <b>Get Dictionary Value</b>: <b>text</b> from Contents of URL. Then <b>If</b>{' '}
            Dictionary Value <b>has any value</b>: <b>Show Notification</b> with Dictionary Value.
            The text is the list — or, if something’s wrong (a revoked token, a deleted place), what
            to fix.
          </li>
          <li>
            Under <b>Otherwise</b>: <b>Get Dictionary Value</b> <b>count</b> from Contents of URL,
            then <b>If</b> it <b>does not have any value</b>: <b>Show Notification</b> “{NO_ANSWER}
            ”. End If, End If. An empty list still has a count, so the Shortcut stays quiet; an
            answer with neither (a server error or throttle) still tells you.
          </li>
          <li>
            <div className="flex flex-col gap-1.5">
              <span>
                For each store: Automation → + → <b>Arrive</b> → pick the store’s location. Choose{' '}
                <b>Run Immediately</b> and turn <b>Notify When Run</b> off. Its one action:{' '}
                <b>Run Shortcut</b> → Aperture list, with the store’s link word as the input.
              </span>
              {places.length > 0 && (
                <ul className="flex flex-col gap-0.5 pl-1">
                  {places.map((p) => (
                    <li key={p.id} className="text-ink-muted">
                      {p.name} → <code>{p.slug}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
          <li className="text-ink-muted">
            Rotated the token? Paste the new one into Aperture list’s header — the automations stay
            as they are. Use <b>Test</b> on a place above to see what its banner will say.
          </li>
        </ol>
      )}
    </Card>
  );
}

// A value to paste into the Shortcut, shown whole — it wraps rather than scroll or truncate, so the URL's
// tail ("…/tasks") is readable on a phone. Copy goes through the clipboard; where that's refused, the text
// selects in one tap.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copy, setCopy] = useState<null | 'copied' | 'failed'>(null);
  const id = useId();
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Text size="xs" tone="muted" id={id}>
        {label}
      </Text>
      <div className="flex items-start gap-2">
        <code
          aria-labelledby={id}
          className="min-w-0 flex-1 select-all break-all rounded-lg border border-line bg-panel px-2 py-1 font-mono text-ink"
        >
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => void onCopy()}
        >
          Copy
        </Button>
      </div>
      <span role="status">
        {copy && (
          <Text size="xs" tone={copy === 'copied' ? 'teal' : 'danger'}>
            {copy === 'copied' ? 'Copied' : 'Couldn’t copy — select it and copy by hand.'}
          </Text>
        )}
      </span>
    </div>
  );
}
