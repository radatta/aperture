import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '.';

describe('EmptyState', () => {
  it('the error branch offers Retry when given onRetry, and never the empty copy', () => {
    const onRetry = vi.fn();
    render(<EmptyState error onRetry={onRetry} title="No habits yet" />);
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn.t load this/);
    expect(screen.queryByText('No habits yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
