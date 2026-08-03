import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { LogEntry } from '@aperture/shared';
import { fmtTime } from '../../lib/format';
import { Text } from '../../components/Text';

// A single timestamped log line with light inline edit (typo fixes). No backdating — the timestamp
// is fixed at capture; only the text is editable.
export function LogEntryRow({ entry, onSave }: { entry: LogEntry; onSave: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);

  function commit() {
    const value = draft.trim();
    setEditing(false);
    if (value && value !== entry.text) onSave(value);
    else setDraft(entry.text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      setDraft(entry.text);
      setEditing(false);
    }
  }

  return (
    <div className="flex gap-3 py-2">
      <div className="w-16 shrink-0 pt-0.5">
        <Text size="xs" tone="subtle" tabular>
          {fmtTime(entry.createdAt)}
        </Text>
      </div>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          aria-label="Edit entry"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-ink outline-none focus:border-teal"
        />
      ) : (
        <button type="button" onClick={() => setEditing(true)} className="flex-1 text-left">
          <Text>{entry.text}</Text>
        </button>
      )}
    </div>
  );
}
