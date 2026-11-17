import { describe, expect, it } from 'vitest';
import { viteReloads } from './server';

describe('viteReloads', () => {
  it("picks Vite's reload and update lines out of a coloured log, and nothing else", () => {
    const log = [
      '',
      '  \x1b[32mVITE\x1b[39m v8.2.0  ready in 367 ms',
      '  ➜  Local:   http://127.0.0.1:35915/',
      '10:11:35 PM \x1b[36m[vite]\x1b[39m (client) dependency optimized: @mediapipe/tasks-vision',
      '10:14:14 PM \x1b[36m[vite]\x1b[39m (client) \x1b[32mpage reload \x1b[39msrc/data/seed.ts',
      '10:15:02 PM [vite] ✨ optimized dependencies changed. reloading',
      '10:16:00 PM [vite] (client) hmr update /src/App.tsx',
    ].join('\n');
    expect(viteReloads(log)).toEqual([
      '10:14:14 PM [vite] (client) page reload src/data/seed.ts',
      '10:15:02 PM [vite] ✨ optimized dependencies changed. reloading',
      '10:16:00 PM [vite] (client) hmr update /src/App.tsx',
    ]);
  });
  it('an empty log has none', () => expect(viteReloads('')).toEqual([]));
});
