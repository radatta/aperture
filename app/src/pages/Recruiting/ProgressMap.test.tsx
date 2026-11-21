import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Square } from './ProgressMap';

// F397: a due square gets a dot under it (a `before:` box), never an outline, and keeps its size.
describe('the Map’s square', () => {
  const cls = (el: Element) => el.getAttribute('class') ?? '';
  it('due: a dot under it, the same gap under a bordered and a filled square; no outline', () => {
    for (const [kind, top] of [
      ['untried', 'before:top-[calc(100%+2px)]'],
      ['clean', 'before:top-[calc(100%+0.5px)]'],
    ] as const) {
      const { container, unmount } = render(<Square kind={kind} due small />);
      const c = cls(container.firstElementChild!);
      expect(c).toContain('before:rounded-full');
      expect(c).toContain(top);
      expect(c).toContain('size-2.5');
      expect(c).not.toMatch(/outline/);
      unmount();
    }
  });
  it('not due: no dot', () => {
    const { container } = render(<Square kind="solved" />);
    expect(cls(container.firstElementChild!)).not.toMatch(/before:/);
  });
});
