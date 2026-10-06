import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Modal } from '.';

// jsdom's showModal() stub (test/setup.ts) only toggles `open` — it never runs the browser's focusing
// steps, so "the first field is NOT focused" for initialFocus='dialog' is verified in the browser.
describe('Modal initial focus', () => {
  it('focuses a data-autofocus child by default', () => {
    render(
      <Modal open onClose={() => {}} label="Pick">
        <button>First</button>
        <button data-autofocus>Chosen</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chosen' }));
    expect(screen.getByRole('dialog').hasAttribute('autofocus')).toBe(false);
  });

  it("focuses the dialog itself with initialFocus='dialog', so no field (and no keyboard)", () => {
    render(
      <Modal open onClose={() => {}} label="Read me" initialFocus="dialog">
        <textarea aria-label="Title" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Read me' });
    expect(document.activeElement).toBe(dialog);
    expect(dialog.hasAttribute('autofocus')).toBe(true);
    expect(dialog.tabIndex).toBe(-1);
  });
});
