import { afterEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { useKeyboardInset } from './useKeyboardInset';

// jsdom has no visualViewport; each test installs a fake and afterEach restores the original
// (shared-jsdom contract — no global leaks into the next file).
const root = document.documentElement;
const originalVv = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const originalClient = Object.getOwnPropertyDescriptor(root, 'clientHeight');

function fakeViewport(layout: number, height: number) {
  const vv = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: layout });
  return vv;
}

afterEach(() => {
  if (originalVv) Object.defineProperty(window, 'visualViewport', originalVv);
  else delete (window as { visualViewport?: unknown }).visualViewport;
  if (originalClient) Object.defineProperty(root, 'clientHeight', originalClient);
  else delete (root as { clientHeight?: unknown }).clientHeight;
});

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const lifted = useKeyboardInset(ref);
  return (
    <>
      <input aria-label="page field" />
      <div ref={ref} data-testid="dock" data-lifted={lifted}>
        <textarea aria-label="dock field" />
      </div>
    </>
  );
}

function setup(layout = 844, height = 844) {
  const vv = fakeViewport(layout, height);
  const r = render(<Harness />);
  const dock = r.getByTestId('dock');
  const keyboard = (h: number, offsetTop = 0) =>
    act(() => {
      vv.height = h;
      vv.offsetTop = offsetTop;
      vv.dispatchEvent(new Event('resize'));
    });
  return { vv, dock, keyboard, ...r };
}

describe('useKeyboardInset', () => {
  it('stays put with no keyboard', () => {
    const { dock, getByLabelText } = setup();
    act(() => getByLabelText('dock field').focus());
    expect(dock.style.bottom).toBe('');
    expect(dock.dataset.lifted).toBe('false');
  });

  it('lifts by the hidden gap while the dock has focus, following pans', () => {
    const { vv, dock, keyboard, getByLabelText } = setup();
    act(() => getByLabelText('dock field').focus());
    keyboard(450);
    expect(dock.style.bottom).toBe('394px');
    expect(dock.style.maxHeight).toBe('450px');
    expect(dock.dataset.lifted).toBe('true');

    act(() => {
      vv.offsetTop = 100; // iOS panned to show the caret
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(dock.style.bottom).toBe('294px');

    keyboard(844);
    expect(dock.style.bottom).toBe('');
    expect(dock.style.maxHeight).toBe('');
  });

  it("doesn't lift for a page field's keyboard — it would cover the field", () => {
    const { dock, keyboard, getByLabelText } = setup();
    act(() => getByLabelText('page field').focus());
    keyboard(450);
    expect(dock.style.bottom).toBe('');
  });

  it('drops the lift when focus leaves the dock', () => {
    const { dock, keyboard, getByLabelText } = setup();
    act(() => getByLabelText('dock field').focus());
    keyboard(450);
    act(() => getByLabelText('page field').focus());
    expect(dock.style.bottom).toBe('');
    expect(dock.dataset.lifted).toBe('false');
  });

  it("doesn't lift when pinch-zoomed", () => {
    const { vv, dock, getByLabelText } = setup();
    act(() => getByLabelText('dock field').focus());
    act(() => {
      vv.scale = 2;
      vv.height = 422;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(dock.style.bottom).toBe('');
  });

  it('ignores sub-pixel noise', () => {
    const { dock, keyboard, getByLabelText } = setup();
    act(() => getByLabelText('dock field').focus());
    keyboard(843.4);
    expect(dock.style.bottom).toBe('');
  });

  it('does nothing where visualViewport is missing', () => {
    delete (window as { visualViewport?: unknown }).visualViewport;
    const r = render(<Harness />);
    expect(r.getByTestId('dock').dataset.lifted).toBe('false');
  });
});
