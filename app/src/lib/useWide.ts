import { useEffect, useState } from 'react';

// Desktop layout or not. No matchMedia (jsdom) reads as narrow.
export function useWide(query = '(min-width: 1024px)') {
  const [wide, setWide] = useState(
    () => (typeof window !== 'undefined' && window.matchMedia?.(query).matches) || false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}
