// Task notes: free-form light markdown on a task. The app renders a small subset to React elements
// (never HTML), so storage is just text. One cap, enforced by every writer through normalizeNotes.
export const TASK_NOTES_MAX = 5000;
// The reflection: one optional look back at a finished task, same markdown subset, a shorter cap.
export const TASK_REFLECTION_MAX = 1000;

// CRLF → LF, trim, empty → null, over the cap throws `<label> … limited to N characters`.
function normalizeText(
  value: string | null | undefined,
  max: number,
  label: string,
  verb: string,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return null;
  if (trimmed.length > max)
    throw new Error(`${label} ${verb} limited to ${max.toLocaleString('en-US')} characters`);
  return trimmed;
}

// The one normalizer every notes write runs: CRLF → LF, trim, empty → null, over the cap throws.
export const normalizeNotes = (notes: string | null | undefined): string | null =>
  normalizeText(notes, TASK_NOTES_MAX, 'Notes', 'are');

// The one normalizer every reflection write runs — same rules as notes, TASK_REFLECTION_MAX.
export const normalizeReflection = (reflection: string | null | undefined): string | null =>
  normalizeText(reflection, TASK_REFLECTION_MAX, 'Reflection', 'is');

// setTaskNotes' argument: like normalizeNotes, but a MISSING value is an error, not a clear — a call that
// dropped its second argument (JSON has no undefined) must never silently wipe a note. null clears.
export function setNotesArg(notes: string | null | undefined): string | null {
  if (notes === undefined) throw new Error('Notes are required — pass null to clear them');
  return normalizeNotes(notes);
}

// setTaskReflection's argument: missing is an error, never a silent clear (as setNotesArg). null clears.
export function setReflectionArg(reflection: string | null | undefined): string | null {
  if (reflection === undefined) throw new Error('Reflection is required — pass null to clear it');
  return normalizeReflection(reflection);
}
