import { useId, useState } from 'react';
import {
  normalizePrepTarget,
  normalizeSittingReview,
  REVIEW_HOW_MAX,
  REVIEW_INSIGHT_MAX,
  REVIEW_MISTAKES_MAX,
  REVIEW_TAG_MAX,
  REVIEW_TAGS_MAX,
  suggestedHelp,
} from '@aperture/shared';
import type { DraftFailReason, HelpLevel, Sitting } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { ModeToggle } from '../../components/ModeToggle';
import { Text } from '../../components/Text';
import {
  useDraftSittingReview,
  useSetSittingPrepTarget,
  useSetSittingReview,
} from '../../data/hooks/useSittings';
import { NotesField } from '../../modules/tasks/notes/NotesField';

const HELP: { value: HelpLevel; label: string }[] = [
  { value: 'none', label: 'No help' },
  { value: 'hint', label: 'A hint' },
  { value: 'solution', label: 'The solution' },
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

// The sitting's review (docs/areas/recruiting → Review): his one-liner, how much help it took, the mistakes,
// how it went, his own pattern tags and the prep target — one Save for all of it. "Draft with Claude" only
// proposes mistake lines, unticked; only the ones he ticks (edited or not) are saved. A failed save keeps every
// field and says why.
export function ReviewForm({ sitting }: { sitting: Sitting }) {
  const saved = sitting.review ?? null;
  const [insight, setInsight] = useState(saved?.insight ?? '');
  const [help, setHelp] = useState<HelpLevel>(saved?.help ?? suggestedHelp(sitting));
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
  const setReview = useSetSittingReview();
  const setPrepTarget = useSetSittingPrepTarget();
  const drafting = useDraftSittingReview();
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const id = useId();

  const ticked = draft.filter((d) => d.ticked && d.text.trim());
  const insightOver = insight.trim().length > REVIEW_INSIGHT_MAX;
  const howOver = howItWent.trim().length > REVIEW_HOW_MAX;

  function addTag(raw: string) {
    const t = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return;
    if (t.length > REVIEW_TAG_MAX)
      return setError(`A tag is limited to ${REVIEW_TAG_MAX} characters.`);
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagText('');
    setError(null);
  }

  async function draftIt() {
    setDraftNote(null);
    try {
      const out = await drafting.mutateAsync(sitting.id);
      if (!out.ok) return setDraftNote(DRAFT_FAILED[out.reason]);
      if (!out.mistakes.length) return setDraftNote('Claude found nothing to add.');
      setDraft(out.mistakes.map((text) => ({ text, ticked: false })));
    } catch {
      setDraftNote(DRAFT_FAILED.network);
    }
  }

  async function save() {
    setError(null);
    setStatus(null);
    const all = [...mistakes, ...ticked.map((d) => d.text)];
    const usedDraft = ticked.length > 0 || (!!saved?.draftUsed && mistakes.length > 0);
    const input = {
      insight: insight || null,
      help,
      mistakes: all,
      howItWent: howItWent || null,
      tags: tagText.trim() ? [...tags, tagText.trim().toLowerCase()] : tags,
      draftUsed: usedDraft,
    };
    let prepTag: string;
    try {
      normalizeSittingReview(input); // refuse here what the server would, keeping every field
      prepTag = normalizePrepTarget(prep);
    } catch (e) {
      setError(`${(e as Error).message}.`);
      return;
    }
    setBusy(true);
    try {
      await setReview.mutateAsync({ id: sitting.id, review: input });
      if (prepTag !== sitting.prepTarget)
        await setPrepTarget.mutateAsync({ id: sitting.id, prepTarget: prepTag });
      setMistakes(all.map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean));
      setDraft([]);
      setTagText('');
      setStatus('Saved.');
    } catch {
      setError('Couldn’t save the review — check your connection and try again. Nothing was lost.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-4">
      <Text as="h2" id={`${id}-h`} size="lg" weight="semibold">
        Review
      </Text>
      <div className="flex flex-col gap-1">
        <Field
          label="One-liner"
          placeholder="The idea that cracked it, or what to remember"
          value={insight}
          onChange={(e) => setInsight(e.target.value)}
          aria-invalid={insightOver || undefined}
        />
        {insight.trim().length > REVIEW_INSIGHT_MAX - 40 && (
          <Text size="xs" tabular tone={insightOver ? 'danger' : 'muted'} className="self-end">
            {insight.trim().length} / {REVIEW_INSIGHT_MAX}
            {insightOver && ' · too long to save'}
          </Text>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Text size="sm" tone="muted" id={`${id}-help`}>
          Help
        </Text>
        <div aria-labelledby={`${id}-help`} role="group">
          <ModeToggle options={HELP} value={help} onChange={setHelp} size="sm" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Text size="sm" tone="muted">
          Mistakes
        </Text>
        {mistakes.map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Field
                aria-label={`Mistake ${i + 1}`}
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
              onClick={() => setMistakes(mistakes.filter((_, j) => j !== i))}
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
            onClick={() => mistakes.length < REVIEW_MISTAKES_MAX && setMistakes([...mistakes, ''])}
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
              <Text size="sm" tone="muted">
                Claude’s draft — tick the lines to keep
              </Text>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setDraft(draft.map((d) => ({ ...d, ticked: true })))}
              >
                Use all
              </Button>
            </div>
            {draft.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Keep draft line ${i + 1}`}
                  checked={d.ticked}
                  onChange={(e) =>
                    setDraft(
                      draft.map((x, j) => (j === i ? { ...x, ticked: e.target.checked } : x)),
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <Field
                    aria-label={`Draft line ${i + 1}`}
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
          <ul aria-label="Your tags" className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <li
                key={t}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pr-1 pl-2.5"
              >
                <Text size="sm">{t}</Text>
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => setTags(tags.filter((x) => x !== t))}
                  className="rounded-full px-1.5 text-sm text-ink-muted hover:bg-panel-2 hover:text-ink"
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
