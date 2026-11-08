import { describe, expect, it } from 'vitest';
import { USER_TIME_ZONE } from '@aperture/shared';

// vitest.config.ts pins the user's zone, as their browser runs; this fails if the pin stops reaching
// the workers.
describe('test time zone', () => {
  it("is the user's zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(USER_TIME_ZONE);
    expect(new Date(Date.UTC(2026, 10, 8, 5, 30)).getHours()).toBe(21); // 05:30Z = 9:30pm PST
  });
});
