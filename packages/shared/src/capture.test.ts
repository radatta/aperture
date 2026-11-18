import { describe, expect, it } from 'vitest';
import {
  captureSay,
  captureWhen,
  isTokenScope,
  SCOPED_TOKENS_MAX,
  scopedTokenNameError,
} from './capture';

describe('scopedTokenNameError', () => {
  const others = [{ name: 'iPhone' }];
  it('needs a name, at most 40 characters, unique in any case', () => {
    expect(scopedTokenNameError('Raycast', others)).toBeNull();
    expect(scopedTokenNameError('   ', others)).toBe('A token needs a name');
    expect(scopedTokenNameError('x'.repeat(40), others)).toBeNull();
    expect(scopedTokenNameError('x'.repeat(41), others)).toMatch(/at most 40/);
    expect(scopedTokenNameError(' IPHONE ', others)).toBe(
      'Another token is already called “iPhone”',
    );
  });
  it('a full scope refuses first, whatever the name', () => {
    const full = Array.from({ length: SCOPED_TOKENS_MAX }, (_, i) => ({ name: `t${i}` }));
    expect(scopedTokenNameError('', full)).toMatch(/At most 5 tokens/);
  });
  it('knows its scopes', () => {
    expect(isTokenScope('capture')).toBe(true);
    expect(isTokenScope('admin')).toBe(false);
    expect(isTokenScope(1)).toBe(false);
  });
});

describe('captureSay', () => {
  const base = {
    title: 'call mum',
    due: null,
    placeName: null,
    calendarToday: '2026-11-16',
    appToday: '2026-11-16',
    raw: false,
    duplicate: false,
  };

  it('says what was added and when', () => {
    expect(captureSay(base)).toBe('Added: call mum.');
    expect(captureSay({ ...base, due: { day: '2026-11-16', time: '17:00' } })).toBe(
      'Added: call mum, today 5 PM.',
    );
    expect(captureSay({ ...base, due: { day: '2026-11-17', time: '09:00' } })).toBe(
      'Added: call mum, tomorrow 9 AM.',
    );
    expect(captureSay({ ...base, due: { day: '2026-11-20', time: null } })).toBe(
      'Added: call mum, Friday.',
    );
    expect(captureSay({ ...base, placeName: 'Grocer', title: 'milk.' })).toBe(
      'Added to Grocer: milk.',
    );
  });

  it('a timed task reads against the calendar date, a day-only one against the app day', () => {
    // 1 AM Tuesday: the app's today is still Monday.
    const night = { ...base, calendarToday: '2026-11-17', appToday: '2026-11-16' };
    expect(captureWhen({ day: '2026-11-17', time: '05:00' }, '2026-11-17', '2026-11-16')).toBe(
      'today 5 AM',
    );
    expect(captureSay({ ...night, due: { day: '2026-11-17', time: null } })).toBe(
      'Added: call mum, tomorrow.',
    );
  });

  it('a raw save says so; a duplicate says it was already added', () => {
    expect(captureSay({ ...base, raw: true, title: 'call mum at five' })).toBe(
      'Added as typed, with no date or time: call mum at five.',
    );
    expect(
      captureSay({ ...base, duplicate: true, due: { day: '2026-11-16', time: '17:00' } }),
    ).toBe('Already added: call mum, today 5 PM.');
    expect(captureSay({ ...base, duplicate: true, raw: true })).toBe('Already added: call mum.');
  });

  it('a raw save with its own words\' time says it was added without AI, and when', () => {
    expect(
      captureSay({
        ...base,
        raw: true,
        title: 'call mum at 5',
        due: { day: '2026-11-16', time: '17:00' },
      }),
    ).toBe('Added without AI, as typed: call mum at 5, today 5 PM.');
  });

  it('cuts a long title at a word', () => {
    const say = captureSay({ ...base, title: `${'word '.repeat(30)}end` });
    expect(say.startsWith('Added: word word')).toBe(true);
    expect(say.endsWith('word….')).toBe(true);
    expect(say.length).toBeLessThan(100);
  });
});
