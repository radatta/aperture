// A page-level shortcut must not fire while you type: text-like inputs, textareas, selects and
// contentEditable all swallow keys (CONVENTIONS → Page keyboard shortcuts).
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export function isTypingTarget(el: EventTarget | Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return (
    el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable
  );
}
