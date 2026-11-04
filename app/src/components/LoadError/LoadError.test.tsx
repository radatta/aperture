import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoadError } from '.';

describe('LoadError', () => {
  it('says what failed as an alert, with a Retry that calls back', () => {
    const onRetry = vi.fn();
    render(<LoadError onRetry={onRetry}>Couldn’t load categories.</LoadError>);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load categories.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('omits Retry when there is nothing to retry', () => {
    render(<LoadError>Couldn’t load categories.</LoadError>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
