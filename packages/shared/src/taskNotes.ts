// Task notes: free-form light markdown on a task. The app renders a small subset to React elements
// (never HTML), so storage is just text. One cap, enforced by every writer through normalizeNotes.
export const TASK_NOTES_MAX = 5000;

// The one normalizer every notes write runs: CRLF → LF, trim, empty → null, over the cap throws.
export function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  if (typeof notes !== 'string') throw new Error('Notes must be text');
  const trimmed = notes.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return null;
  if (trimmed.length > TASK_NOTES_MAX)
    throw new Error(`Notes are limited to ${TASK_NOTES_MAX.toLocaleString('en-US')} characters`);
  return trimmed;
}
