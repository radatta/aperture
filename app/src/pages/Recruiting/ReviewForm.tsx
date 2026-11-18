import { useId, useRef, useState } from 'react';
import {
  CAUSE_NAMES,
  CAUSE_TAGS,
  hasReviewWords,
  normalizePrepTarget,
  normalizeSittingReview,
  REVIEW_HOW_MAX,
  REVIEW_INSIGHT_MAX,
  REVIEW_MISTAKES_MAX,
  REVIEW_TAG_MAX,
  REVIEW_TAGS_MAX,
  suggestedHelp,
} from '@aperture/shared';
import type { CauseTag, DraftFailReason, HelpLevel, Sitting } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { ModeToggle } from '../../components/ModeToggle';
import { Text } from '../../components/Text';
import {
  useDraftSittingReview,
  useReadSittingReview,
  useSetSittingPrepTarget,
  useSetSittingReview,
} from '../../data/hooks/useSittings';
import { cx } from '../../lib/cx';
import { suggestedCause } from './recruitingHelpers';
import { NotesField } from '../../modules/tasks/notes/NotesField';
import { notesValue } from '../../modules/tasks/notes/parseNotes';
import { Textarea } from '../../components/Textarea';

const HELP: { value: HelpLevel; label: string }[] = [
  { value: 'none', label: 'No help' },
  { value: 'hint', label: 'A hint' },
  { value: 'solution', label: 'Peeked' }, // the coach's "peeked": the solution was read
];
const DRAFT_FAILED: Record<DraftFailReason, string> = {
  'nothing-to-draft': 'Nothing to draft yet — no run or submit was judged.',
  unavailable: 'Couldn’t draft — Claude isn’t available here. Write your own.',
  timeout: 'Couldn’t draft — it took too long. Write your own.',
  network: 'Couldn’t draft — check your connection. Write your own.',
  api: 'Couldn’t draft — Claude didn’t answer. Write your own.',
  'bad-json': 'Couldn’t draft — the answer didn’t read. Write your own.',
  'bad-shape': 'Couldn’t draft — the answer broke the rules. Write your own.',
};
type DraftLine = { text: string; ticked: boolean };
export const REVIEW_ID = 'sitting-review'; // End sitting's Mark done sends focus here
const folded = (s: string) => s.replace(/\s+/g, ' ').trim(); // as the server counts it
const focusOnMount = (el: HTMLTextAreaElement | null) => el?.focus();

// The sitting's review (docs/areas/recruiting → Review): the user's one-liner, how much help it took (Peeked is
// the coach's peeked), the coach's one cause tag, the mistakes, how it went, their own pattern tags and the prep
// target — one Save for all of it. "Draft with Claude" only proposes: mistake lines, unticked, of which only the
// ones they tick (edited or not) are saved; and a cause, which marks its chip and is saved only if tapped. A
// failed save keeps every field and says why.
//
// Help and the cause are also Claude's to set over MCP (mark_peeked, set_cause_tag), maybe after this form
// opened. So until the user touches one, it follows the stored review as it refreshes, and Save doesn't send it —
// the server keeps what's stored (mergeReview), never the stale value the form opened on (F169). Help and the cause
// are only suggested while there's no review of the user's own: once one is stored, its own values (none included)
// show. A review that only voids the sitting (Doesn't count) is none (hasReviewWords).
const startCause = (s: Sitting): CauseTag | null =>
  hasReviewWords(s.review) ? (s.review!.cause ?? null) : suggestedCause(s);

export function ReviewForm({ sitting }: { sitting: Sitting }) {
  const saved = sitting.review ?? null;
  const own = hasReviewWords(saved) ? saved : null; // the suggestions show while this is null
  const [insight, setInsight] = useState(saved?.insight ?? '');
  const [help, setHelp] = useState<HelpLevel>(own?.help ?? suggestedHelp(sitting));
  const [cause, setCause] = useState<CauseTag | null>(startCause(sitting));
  const [touched, setTouched] = useState({ help: false, cause: false });
  const [syncedAt, setSyncedAt] = useState(saved?.updatedAt ?? null);
  if ((saved?.updatedAt ?? null) !== syncedAt) {
    // The stored review moved (a save here, or Claude's write elsewhere): untouched fields follow it.
    setSyncedAt(saved?.updatedAt ?? null);
    if (!touched.help) setHelp(own?.help ?? suggestedHelp(sitting));
    if (!touched.cause) setCause(startCause(sitting));
  }
  const readReview = useReadSittingReview();
  const [mistakes, setMistakes] = useState<string[]>(saved?.mistakes ?? []);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [howItWent, setHowItWent] = useState(saved?.howItWent ?? '');
  const [editingHow, setEditingHow] = useState(false);
  const [tags, setTags] = useState<string[]>(saved?.tags ?? []);
  const [tagText, setTagText] = useState('');
  const [prep, setPrep] = useState(sitting.prepTarget);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false); // a double click lands both clicks before `busy` renders
  const setReview = useSetSittingReview();
  const setPrepTarget = useSetSittingPrepTarget();
  const drafting = useDraftSittingReview();
  const [draftNote, setDraftNote] = useState<string | null>(null);
  // The draft's cause: a proposal that marks its chip and never picks it — saved only if tapped, like a line.
  const [proposed, setProposed] = useState<CauseTag | null>(null);
  const id = useId();
  const chips = useRef<HTMLUListElement>(null);
  const tagBox = useRef<HTMLInputElement>(null);
  const [focusMistake, setFocusMistake] = useState<number | null>(null); // the line Add a mistake made

  const ticked = draft.filter((d) => d.ticked && d.text.trim());
  const showProposal = proposed !== null && proposed !== cause;
  const insightLen = folded(insight).length;
  const insightOver = insightLen > REVIEW_INSIGHT_MAX;
  const howOver = notesValue(howItWent).length > REVIEW_HOW_MAX; // multi-line: the server keeps line breaks

  function addTag(raw: string) {
    const t = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return;
    if (t.length > REVIEW_TAG_MAX)
      return setError(`A tag is limited to ${REVIEW_TAG_MAX} characters.`);
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagText('');
    setError(null);
  }

  // Focus stays in the chips (the next one, else the box) rather than dropping to the page.
  function removeTag(t: string) {
    const at = tags.indexOf(t);
    const rest = tags.filter((x) => x !== t);
    setTags(rest);
    requestAnimationFrame(() => {
      const next = chips.current?.querySelectorAll('button')[Math.min(at, rest.length - 1)];
      (next ?? tagBox.current)?.focus();
    });
  }

  async function draftIt() {
    setDraftNote(null);
    setProposed(null);
    try {
      const out = await drafting.mutateAsync(sitting.id);
      if (!out.ok) return setDraftNote(DRAFT_FAILED[out.reason]);
      setProposed(out.cause ?? null);
      if (!out.mistakes.length) return setDraftNote('Claude found nothing to add.');
      setDraft(out.mistakes.map((text) => ({ text, ticked: false })));
    } catch {
      setDraftNote('Couldn’t draft — the request failed. Write your own.');
    }
  }

  async function save() {
    setError(null);
    setStatus(null);
    const all = [...mistakes, ...ticked.map((d) => d.text)];
    const usedDraft = ticked.length > 0 || (!!saved?.draftUsed && mistakes.length > 0);
    const input = {
      insight: insight || null,
      mistakes: all,
      howItWent: howItWent || null,
      tags: tagText.trim() ? [...tags, tagText.trim().toLowerCase()] : tags,
      draftUsed: usedDraft,
      ...(touched.help ? { help } : {}),
      ...(touched.cause ? { cause } : {}),
    };
    let prepTag: string;
    let normal: ReturnType<typeof normalizeSittingReview>;
    try {
      normal = normalizeSittingReview(input); // refuse here what the server would, keeping every field
      prepTag = normalizePrepTarget(prep);
    } catch (e) {
      setError(`${(e as Error).message}.`);
      return;
    }
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    let step: 'review' | 'prep' = 'review';
    try {
      // A first review sends the untouched suggestions (a hint, No trace) — but only if there's still no review
      // as of now: one Claude wrote since the form opened wins. Help and the cause refuse taps while this runs, so
      // `touched` is the one Save was pressed on.
      const suggests = !own && ((!touched.help && help !== 'none') || (!touched.cause && !!cause));
      if (suggests && !hasReviewWords(await readReview(sitting.id)))
        Object.assign(input, {
          ...(touched.help ? {} : { help }),
          ...(touched.cause || !cause ? {} : { cause }),
        });
      await setReview.mutateAsync({ id: sitting.id, review: input });
      step = 'prep';
      if (prepTag !== sitting.prepTarget)
        await setPrepTarget.mutateAsync({ id: sitting.id, prepTarget: prepTag });
      // The form now shows what was saved — a tag still in the box becomes a chip, so the next Save keeps it.
      setFocusMistake(null);
      setMistakes(normal?.mistakes ?? []);
      setTags(normal?.tags ?? []);
      setDraft([]);
      setProposed(null);
      setTagText('');
      setTouched({ help: false, cause: false });
      setStatus('Saved.');
    } catch {
      setError(
        step === 'review'
          ? 'Couldn’t save the review — try again. Your text is still here.'
          : 'The review saved, but the prep target didn’t — try Save again.',
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      id={REVIEW_ID}
      tabIndex={-1}
      aria-labelledby={`${id}-h`}
      className="flex flex-col gap-4 outline-none"
    >
      <Text as="h2" id={`${id}-h`} size="lg" weight="semibold">
        Review
      </Text>
      <div className="flex flex-col gap-1">
        <Field
          label="One-liner"
          placeholder="The idea that cracked it"
          value={insight}
          onChange={(e) => setInsight(e.target.value)}
          aria-invalid={insightOver || undefined}
        />
        {insightLen > REVIEW_INSIGHT_MAX - 40 && (
          <Text size="xs" tabular tone={insightOver ? 'danger' : 'muted'} className="self-end">
            {insightLen} / {REVIEW_INSIGHT_MAX}
            {insightOver && ' · too long to save'}
          </Text>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Text size="sm" tone="muted" id={`${id}-help`}>
          Help
        </Text>
        <ModeToggle
          options={HELP}
          value={help}
          onChange={(v) => {
            if (busy) return;
            setHelp(v);
            setTouched((t) => ({ ...t, help: true }));
          }}
          size="sm"
          aria-labelledby={`${id}-help`}
          className="self-start"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Text size="sm" tone="muted" id={`${id}-cause`}>
          Cause
          {!touched.cause && !own && cause && (
            <Text as="span" size="xs" tone="subtle">
              {' '}
              · suggested
            </Text>
          )}
        </Text>
        {/* One choice; tapping the chosen one clears it. */}
        <div role="group" aria-labelledby={`${id}-cause`} className="flex flex-wrap gap-1.5">
          {CAUSE_TAGS.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cause === c}
              aria-disabled={busy || undefined}
              aria-describedby={showProposal && proposed === c ? `${id}-proposed` : undefined}
              onClick={() => {
                if (busy) return;
                setCause(cause === c ? null : c);
                setTouched((t) => ({ ...t, cause: true }));
              }}
              className={cx(
                'rounded-full border px-3 py-1.5 text-sm transition',
                cause === c
                  ? 'border-teal-soft bg-teal-soft font-medium text-ink'
                  : showProposal && proposed === c
                    ? 'border-dashed border-teal bg-surface text-ink'
                    : 'border-line bg-surface text-ink-muted hover:text-ink',
              )}
            >
              {CAUSE_NAMES[c]}
            </button>
          ))}
        </div>
        {/* Always mounted, so a screen reader hears the proposal when a draft brings one. */}
        <div aria-live="polite">
          {showProposal && (
            <Text size="xs" tone="muted" id={`${id}-proposed`}>
              Claude suggests {CAUSE_NAMES[proposed]} — tap it to use it.
            </Text>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Text size="sm" tone="muted">
          Mistakes
        </Text>
        {mistakes.map((m, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Textarea
                aria-label={`Mistake ${i + 1}`}
                placeholder="What went wrong"
                rows={1}
                autogrow
                ref={i === focusMistake ? focusOnMount : undefined}
                value={m}
                onChange={(e) =>
                  setMistakes(mistakes.map((x, j) => (j === i ? e.target.value : x)))
                }
              />
            </div>
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Remove mistake ${i + 1}`}
              onClick={() => {
                setFocusMistake(null);
                setMistakes(mistakes.filter((_, j) => j !== i));
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={mistakes.length >= REVIEW_MISTAKES_MAX || undefined}
            onClick={() => {
              if (mistakes.length >= REVIEW_MISTAKES_MAX) return;
              setFocusMistake(mistakes.length);
              setMistakes([...mistakes, '']);
            }}
          >
            Add a mistake
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={drafting.isPending || undefined}
            onClick={() => !drafting.isPending && void draftIt()}
          >
            {drafting.isPending ? 'Drafting…' : 'Draft with Claude'}
          </Button>
        </div>
        <p role="status" className="text-sm text-ink-muted empty:hidden">
          {draftNote}
        </p>
        {draft.length > 0 && (
          <div
            aria-label="Claude’s draft"
            role="group"
            className="flex flex-col gap-2 rounded-xl border border-dashed border-line p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <Text size="sm" tone="muted" className="min-w-0">
                Claude’s draft — tick the lines to keep
              </Text>
              <Button
                variant="quiet"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                onClick={() => setDraft(draft.map((d) => ({ ...d, ticked: true })))}
              >
                Use all
              </Button>
            </div>
            {draft.map((d, i) => (
              <div key={i} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-3 size-5 shrink-0"
                  aria-label={`Keep draft line ${i + 1}`}
                  checked={d.ticked}
                  onChange={(e) =>
                    setDraft(
                      draft.map((x, j) => (j === i ? { ...x, ticked: e.target.checked } : x)),
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <Textarea
                    aria-label={`Draft line ${i + 1}`}
                    rows={1}
                    autogrow
                    value={d.text}
                    onChange={(e) =>
                      setDraft(draft.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <NotesField
        saved={saved?.howItWent}
        value={howItWent}
        editing={editingHow || !saved?.howItWent}
        onEdit={() => setEditingHow(true)}
        onChange={setHowItWent}
        label="How it went"
        max={REVIEW_HOW_MAX}
        counterFrom={900}
        rows={3}
        placeholder="In your words: where it stuck, what you'd do first next time"
        emptyLabel="Add how it went…"
        plural={false}
        focusOnEdit={editingHow}
      />

      <div className="flex flex-col gap-2">
        <Field
          ref={tagBox}
          label="Tags"
          placeholder="Your own pattern tags — Enter adds"
          value={tagText}
          onChange={(e) => {
            const v = e.target.value;
            if (v.endsWith(',')) addTag(v.slice(0, -1));
            else setTagText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag(tagText);
            }
          }}
          aria-describedby={`${id}-tags`}
        />
        <Text size="xs" tone="subtle" id={`${id}-tags`}>
          Up to {REVIEW_TAGS_MAX}.
        </Text>
        {tags.length > 0 && (
          <ul ref={chips} aria-label="Your tags" className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <li
                key={t}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pr-1 pl-2.5"
              >
                <Text size="sm">{t}</Text>
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => removeTag(t)}
                  className="-my-1 grid size-7 place-items-center rounded-full text-sm text-ink-muted hover:bg-panel-2 hover:text-ink"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Field
        label="Prep target"
        placeholder="General"
        value={prep}
        onChange={(e) => setPrep(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          aria-disabled={busy || insightOver || howOver || undefined}
          onClick={() => !busy && !insightOver && !howOver && void save()}
        >
          {busy ? 'Saving…' : 'Save review'}
        </Button>
        <span role="status">
          {status && (
            <Text size="sm" tone="muted">
              {status}
            </Text>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
