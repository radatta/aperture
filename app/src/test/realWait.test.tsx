import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { realWait } from './realWait';

// Each step's effect arms the next 10 ms later, so step 3 needs renders and effects to run during the wait; one act
// around the whole wait leaves it at step 1.
function Chain() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= 3) return;
    const id = setTimeout(() => setN(n + 1), 10);
    return () => clearTimeout(id);
  }, [n]);
  return <p>step {n}</p>;
}

it('realWait lets renders and effects run while it waits', async () => {
  render(<Chain />);
  await realWait(80);
  expect(screen.getByText('step 3')).toBeTruthy();
});
