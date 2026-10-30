import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('hands showModal() the data-autofocus start, so an earlier field is never focused first', () => {
    const stub = HTMLDialogElement.prototype.showModal;
    const focused: string[] = [];
    // The browser's focusing steps: the first [autofocus] descendant, else the first focusable.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
      (
        this.querySelector<HTMLElement>('[autofocus]') ?? this.querySelector<HTMLElement>('input')
      )?.focus();
    };
    try {
      render(
        <Modal open onClose={() => {}} label="Pick">
          <input aria-label="Search" onFocus={() => focused.push('input')} />
          <button data-autofocus onFocus={() => focused.push('chosen')}>
            Chosen
          </button>
        </Modal>,
      );
      expect(focused).toEqual(['chosen']);
      expect(screen.getByRole('button', { name: 'Chosen' }).hasAttribute('autofocus')).toBe(false);
    } finally {
      HTMLDialogElement.prototype.showModal = stub;
    }
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

  it('still ends on the dialog where showModal() focuses the first field (older engines)', () => {
    const stub = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
      this.querySelector<HTMLElement>('textarea, input, button')?.focus(); // ignores autofocus
    };
    try {
      render(
        <Modal open onClose={() => {}} label="Read me" initialFocus="dialog">
          <textarea aria-label="Title" />
        </Modal>,
      );
      expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Read me' }));
    } finally {
      HTMLDialogElement.prototype.showModal = stub;
    }
  });
});

describe('Modal backdrop close', () => {
  afterEach(() => vi.restoreAllMocks());

  // Give the dialog a real box (jsdom lays nothing out), then press and release on the dialog
  // element itself at a point — which is what both a backdrop tap and a padding tap look like.
  function setup() {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} label="Box" closeOnBackdrop>
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Box' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 100, 300, 400));
    const tap = (clientX: number, clientY: number) => {
      fireEvent.mouseDown(dialog, { clientX, clientY });
      fireEvent.click(dialog, { clientX, clientY });
    };
    return { onClose, tap };
  }

  it('closes on a tap outside the box', () => {
    const { onClose, tap } = setup();
    tap(10, 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a tap in the dialog's own padding", () => {
    const { onClose, tap } = setup();
    tap(30, 110); // inside the box, but the target is the <dialog> — its p-5 gutter
    expect(onClose).not.toHaveBeenCalled();
  });
});
