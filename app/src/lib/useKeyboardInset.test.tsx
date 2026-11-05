import { afterEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { useKeyboardInset } from './useKeyboardInset';

// jsdom has no visualViewport; each test installs a fake and afterEach restores the original
// (shared-jsdom contract — no global leaks into the next file).
const root = document.documentElement;
const originalVv = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const originalInner = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const originalClient = Object.getOwnPropertyDescriptor(root, 'clientHeight');

// `viewable` is window.innerHeight — what a fixed element anchors to; `layout` is the static ICB
// (documentElement.clientHeight), which the hook must NOT measure against.
function fakeViewport(viewable: number, height: number, layout = viewable) {
  const vv = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewable });
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: layout });
  return vv;
}

afterEach(() => {
  if (originalVv) Object.defineProperty(window, 'visualViewport', originalVv);
  else delete (window as { visualViewport?: unknown }).visualViewport;
  if (originalInner) Object.defineProperty(window, 'innerHeight', originalInner);
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

function setup(viewable = 844, height = 844, layout = viewable) {
  const vv = fakeViewport(viewable, height, layout);
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

  // A Safari tab with its toolbars collapsed: the ICB stays at the toolbars-shown height (744) while
  // the viewable area grows to 844. `bottom: 0` anchors to the viewable area, so the lift must be the
  // full 394, not the 294 the ICB would give — the chips row sat behind the keyboard on that 100px.
  it('lifts by the full gap in a Safari tab with collapsed toolbars', () => {
    const { dock, keyboard, getByLabelText } = setup(844, 844, 744);
    act(() => getByLabelText('dock field').focus());
    keyboard(450);
    expect(dock.style.bottom).toBe('394px');
    expect(dock.dataset.lifted).toBe('true');
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

  // innerHeight counts a horizontal scrollbar; visualViewport doesn't. A desktop page that overflows
  // sideways with classic scrollbars would otherwise lift the dock 15–17px on every capture focus.
  it("ignores a desktop scrollbar's height — a gap no keyboard could make", () => {
    const { dock, keyboard, getByLabelText } = setup();
    act(() => getByLabelText('dock field').focus());
    keyboard(827);
    expect(dock.style.bottom).toBe('');
    expect(dock.dataset.lifted).toBe('false');
  });

  it('does nothing where visualViewport is missing', () => {
    delete (window as { visualViewport?: unknown }).visualViewport;
    const r = render(<Harness />);
    expect(r.getByTestId('dock').dataset.lifted).toBe('false');
  });
});
