import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRowAction } from './useRowAction';

describe('useRowAction', () => {
  it('a failure is caught; only an explained one keeps its message', async () => {
    const { result } = renderHook(() => useRowAction({ current: null }));
    const refuse = () => Promise.reject(new Error('Part 2 isn’t finished'));
    await act(() => result.current.run('a', refuse));
    expect(result.current).toMatchObject({ failed: true, message: null });
    await act(() => result.current.run('a', refuse, true));
    expect(result.current).toMatchObject({ failed: true, message: 'Part 2 isn’t finished' });
    await act(() => result.current.run('a', () => Promise.resolve()));
    expect(result.current).toMatchObject({ failed: false, message: null });
  });
});
