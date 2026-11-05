import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Textarea } from './index';

// jsdom has no layout: every box measures 0, as a textarea does inside a <dialog> that isn't open yet.
afterEach(() => vi.restoreAllMocks());

describe('Textarea autogrow', () => {
  it('a box with no layout yet keeps its rows’ height — never collapses to 0px', () => {
    render(<Textarea label="Reflection" autogrow rows={2} value="" onChange={() => {}} />);
    const box = screen.getByLabelText<HTMLTextAreaElement>('Reflection');
    expect(box.style.height).toBe(''); // rows={2} holds it, not `height: 0px` (just its padding)
  });

  it('a laid-out box takes its content height plus the border', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(64);
    vi.spyOn(HTMLTextAreaElement.prototype, 'offsetHeight', 'get').mockReturnValue(66);
    vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get').mockReturnValue(64);
    render(
      <Textarea label="Reflection" autogrow rows={2} value="two\nlines" onChange={() => {}} />,
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^Reflection/).style.height).toBe('66px');
  });
});
