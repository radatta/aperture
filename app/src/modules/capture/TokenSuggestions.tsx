import type { Suggestion } from './suggestions';

// The chip row under the capture field. Plain buttons, not a combobox: typing the literal always works
// and there's no arrow-key highlight to promise. Not a live region — it changes on every keystroke.
// mousedown preventDefault keeps focus in the textarea, so a tap on iPhone doesn't drop the keyboard.
export function TokenSuggestions({
  items,
  onPick,
}: {
  items: Suggestion[];
  onPick: (s: Suggestion) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Suggestions"
      className="no-scrollbar -mx-2 flex gap-1.5 overflow-x-auto px-4 pt-1"
    >
      {items.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-label={s.a11y}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(s)}
          className="shrink-0 whitespace-nowrap rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted transition hover:text-ink"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
