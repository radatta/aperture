import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests (RTL auto-cleanup without enabling vitest globals).
afterEach(() => cleanup());
