import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { LogEntry } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { fmtTime } from '../../lib/format';
import { LockIcon, PencilIcon } from '../../components/icons';
import { Text } from '../../components/Text';
import { useAutoGrow } from '../capture/useAutoGrow';

// A single timestamped log line with light inline edit (typo fixes). No backdating — the timestamp
// is fixed at capture; only the text is editable.
//
// The row used to be a bare <button> with no hover state, so nothing on the page suggested an entry
// could be corrected at all. Now the row lifts on hover and a pencil fades in.
//
// The lock is always visible (phones have no hover) and works on any entry, old or new: a private
// entry still reads normally here; only the MCP tools withhold its text (docs/areas/log).
export function LogEntryRow({
  entry,
  onSave,
  onTogglePrivate,
}: {
  entry: LogEntry;
  onSave: (text: string) => void;
  onTogglePrivate: () => void;
}) {
  const isPrivate = entry.private === true;
  // An optimistic row (just captured, not yet saved) has no server id to toggle.
  const saving = entry.id.startsWith('tmp-');
  const textId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Same growing-field behaviour as capture, from the same hook — the old `rows` heuristic guessed
  // line count from character count, which is wrong the moment the column isn't 60ch.
  useAutoGrow(ref, editing ? draft : '');

  function commit() {
    const value = draft.trim();
    setEditing(false);
    if (value && value !== entry.text) onSave(value);
    else setDraft(entry.text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      setDraft(entry.text);
      setEditing(false);
    }
  }

  return (
    <li className="group flex gap-3 py-2">
      {/* fixed and non-wrapping: "10:46 PM" broke onto two lines in the old w-16 column */}
      <div className="w-[4.5rem] shrink-0 pt-0.5">
        <Text size="xs" tone="subtle" tabular className="whitespace-nowrap">
          {fmtTime(entry.createdAt)}
        </Text>
      </div>
      {editing ? (
        <textarea
          ref={ref}
          autoFocus
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          aria-label="Edit entry"
          className="min-w-0 flex-1 resize-none rounded-lg border border-line bg-surface px-2 py-1 text-ink outline-none focus:border-teal"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Edit this entry"
          className="-mx-2 flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-0.5 text-left transition hover:bg-panel"
        >
          <Text id={textId} className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {entry.text}
          </Text>
          {/* focus-within too, or the affordance never shows for anyone arriving by keyboard */}
          <PencilIcon
            size={13}
            className="mt-1 shrink-0 text-ink-subtle opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </button>
      )}
      <button
        type="button"
        onClick={onTogglePrivate}
        disabled={saving}
        aria-pressed={isPrivate}
        aria-label="Private entry"
        // the row's text tells a rotor full of identical "Private entry" buttons apart
        aria-describedby={editing ? undefined : textId}
        title={
          isPrivate
            ? 'Private — hidden from Claude. Tap to make it public'
            : 'Make private — hidden from Claude'
        }
        className={cx(
          '-my-1 flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-panel disabled:opacity-20',
          isPrivate
            ? 'text-teal'
            : 'text-ink-subtle opacity-60 hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        {/* filled when private: colour alone barely tells the two apart in dark mode */}
        <LockIcon size={14} filled={isPrivate} />
      </button>
    </li>
  );
}
