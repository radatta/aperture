import { describe, expect, it } from 'vitest';

// vitest.config.ts pins TZ=UTC like the Lambda runtime; this fails if the pin stops reaching the workers.
describe('test time zone', () => {
  it('is UTC', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
    expect(new Date(Date.UTC(2026, 10, 7, 4, 30)).getHours()).toBe(4);
  });
});
