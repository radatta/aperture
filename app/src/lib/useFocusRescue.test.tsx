import { describe, expect, it } from 'vitest';
import { useCallback, useRef, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useFocusRescue } from './useFocusRescue';

function Page() {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);
  useFocusRescue(
    root,
    useCallback(() => document.getElementById('home'), []),
  );
  return (
    <div ref={root}>
      <button id="home">Refresh</button>
      {shown && (
        <button type="button" onClick={() => setShown(false)}>
          Try again
        </button>
      )}
    </div>
  );
}

describe('useFocusRescue', () => {
  it('hands focus to the fallback when the focused element disappears', async () => {
    render(<Page />);
    const btn = screen.getByRole('button', { name: 'Try again' });
    act(() => btn.focus());
    act(() => btn.click());
    await waitFor(() => expect(document.activeElement?.id).toBe('home'));
  });

  it('leaves focus alone when it already went somewhere', async () => {
    render(<Page />);
    const btn = screen.getByRole('button', { name: 'Try again' });
    act(() => btn.focus());
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
      btn.click();
    });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
