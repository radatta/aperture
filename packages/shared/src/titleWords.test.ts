import { describe, expect, it } from 'vitest';
import { validateParsedTask } from './quickParse';
import { keepTitleWords } from './titleWords';

// Tuesday 2026-11-17, 12:00 in LA.
const ctx = {
  categories: [
    { id: 'c-ap', label: 'Aperture' },
    { id: 'c-gd', label: 'Garden' },
    { id: 'c-sd', label: 'System Design' },
  ],
  places: [],
  today: '2026-11-17',
  dayStartHour: 4,
  now: Date.UTC(2026, 10, 17, 20, 0),
};
const parse = (line: string, over: Record<string, unknown>, voice = false) =>
  validateParsedTask(
    {
      title: line,
      notes: null,
      categoryId: null,
      dueDay: null,
      dueTime: null,
      estimateMin: null,
      ...over,
    },
    { ...ctx, line, voice },
  );
const title = (line: string, over: Record<string, unknown>, voice = false) =>
  parse(line, over, voice)?.input.title;

const TODAY = '2026-11-17';
const FRI = '2026-11-20';

describe('quick-add titles keep the typed words (titleWords.ts)', () => {
  // [line, the model's answer, the title saved]
  const typed: [string, Record<string, unknown>, string][] = [
    // A word the model dropped goes back (F179: 10 of 10 on dev).
    [
      'devcheck m call the bank typed at 1 am',
      { title: 'devcheck m call the bank', dueDay: TODAY, dueTime: '01:00' },
      'devcheck m call the bank typed',
    ],
    ['devcheck m call the bank typed at 1 am', {}, 'devcheck m call the bank typed'],
    [
      'pick up dry cleaning typed at 6 pm',
      { title: 'pick up dry cleaning', dueDay: TODAY, dueTime: '18:00' },
      'pick up dry cleaning typed',
    ],
    [
      'call mom later today 7pm',
      { title: 'call mom', dueDay: TODAY, dueTime: '19:00' },
      'call mom later',
    ],
    ['test the test plan 30m', { title: 'the test plan', estimateMin: 30 }, 'test the test plan'],
    [
      'café résumé à envoyer typed at 1 am',
      { title: 'café résumé à envoyer', dueTime: '01:00' },
      'café résumé à envoyer typed',
    ],
    [
      'fix login (prod!) typed at 1 am.',
      { title: 'fix login (prod!)', dueTime: '01:00' },
      'fix login (prod!) typed',
    ],
    [
      'call the bank typed at 1 am',
      { title: 'Call The Bank', dueTime: '01:00' },
      'call the bank typed',
    ],
    ['call the bank at 6', { title: 'call the bank' }, 'call the bank at 6'],
    // A due phrase the parse used leaves the title (F163).
    ['finish slides before 3pm', { dueDay: TODAY, dueTime: '15:00' }, 'finish slides'],
    [
      'send invoice until 5pm friday',
      { title: 'send invoice until', dueDay: FRI, dueTime: '17:00' },
      'send invoice',
    ],
    [
      'text sam back later today 3pm',
      { title: 'text sam back later today', dueDay: TODAY, dueTime: '15:00' },
      'text sam back later',
    ],
    ['call the bank 6pm', { dueDay: TODAY, dueTime: '18:00' }, 'call the bank'],
    [
      'email landlord tomorrow at 5 pm',
      { title: 'email landlord tomorrow', dueDay: '2026-11-18', dueTime: '17:00' },
      'email landlord',
    ],
    [
      'pay rent due by friday 9am',
      { title: 'pay rent due by friday', dueDay: FRI, dueTime: '09:00' },
      'pay rent',
    ],
    // ...but not when it's part of the task, or the time wasn't set from it.
    ['finish slides before 3pm', {}, 'finish slides before 3pm'],
    ['watch 9pm show', { dueDay: TODAY, dueTime: '21:00' }, 'watch 9pm show'],
    ['email the team about the 3pm meeting', {}, 'email the team about the 3pm meeting'],
    ['move the 3pm to 5pm', { dueDay: TODAY, dueTime: '17:00' }, 'move the 3pm to 5pm'],
    ['3pm meeting prep', { dueDay: TODAY, dueTime: '15:00' }, '3pm meeting prep'],
    ['prep for friday', { dueDay: FRI }, 'prep for friday'],
    [
      'prep for this friday 5pm',
      { title: 'prep for this friday', dueDay: FRI, dueTime: '17:00' },
      'prep for this friday',
    ],
    [
      'plan friday review due friday',
      { title: 'plan friday review', dueDay: FRI },
      'plan friday review',
    ],
    ['pay rent today', { dueDay: TODAY }, 'pay rent today'],
    // A leading word goes only when it names the category the parse set.
    [
      'aperture, fix login bug due fri 30m',
      { title: 'fix login bug', dueDay: FRI, estimateMin: 30 },
      'aperture, fix login bug',
    ],
    [
      'aperture, fix login bug due fri 30m',
      { title: 'fix login bug', categoryId: 'c-ap', dueDay: FRI, estimateMin: 30 },
      'fix login bug',
    ],
    [
      'aperture, fix login bug due fri 30m',
      { title: 'aperture, fix login bug', categoryId: 'c-ap', dueDay: FRI, estimateMin: 30 },
      'fix login bug',
    ],
    ['Garden: prune the roses', { categoryId: 'c-gd' }, 'prune the roses'],
    ['garden - prune the roses', { categoryId: 'c-gd' }, 'prune the roses'],
    [
      'system design, read the paper',
      { title: 'read the paper', categoryId: 'c-sd' },
      'read the paper',
    ],
    ['aperture fix login', { categoryId: 'c-ap' }, 'aperture fix login'],
    ['aperture fix login', { title: 'fix login', categoryId: 'c-ap' }, 'fix login'],
    ['work, email sam', { title: 'email sam', categoryId: 'c-gd' }, 'work, email sam'],
    [
      'devcheck m call the bank at 7 pm',
      { title: 'm call the bank', categoryId: 'c-ap', dueTime: '19:00' },
      'devcheck m call the bank',
    ],
    ['gardening tools sale', { title: 'tools sale', categoryId: 'c-gd' }, 'gardening tools sale'],
    // Review round 1: words that go with a time or day, clocks read from part of a word, a clock the task is about.
    [
      'call mom tomorrow morning 9am',
      { title: 'call mom', dueDay: '2026-11-18', dueTime: '09:00' },
      'call mom',
    ],
    ['call this afternoon 3pm', { title: 'call', dueDay: TODAY, dueTime: '15:00' }, 'call'],
    ['call mom around 5pm', { title: 'call mom', dueTime: '17:00' }, 'call mom'],
    ['call mom at about 5pm', { title: 'call mom', dueTime: '17:00' }, 'call mom'],
    ['read for about 30m', { title: 'read', estimateMin: 30 }, 'read'],
    ['submit by the 20th of nov', { title: 'submit', dueDay: FRI }, 'submit'],
    [
      'pick up kids at 5 p.m. from school',
      { title: 'pick up kids from school', dueTime: '17:00' },
      'pick up kids from school',
    ],
    ['call at 5.30pm', { title: 'call', dueTime: '17:30' }, 'call'],
    ['call 5-6pm', { title: 'call', dueTime: '18:00' }, 'call'],
    ['move standup to 5pm', { dueDay: TODAY, dueTime: '17:00' }, 'move standup to 5pm'],
    ['push dinner to 8pm', { title: 'push dinner', dueTime: '20:00' }, 'push dinner'],
    [
      'buy cake 🎂 for sam typed at 6 pm',
      { title: 'buy cake for sam', dueTime: '18:00' },
      'buy cake 🎂 for sam typed',
    ],
    // The model's title stands when it can't be lined up, or a field has no words to show for it.
    [
      'submit report end of month',
      { title: 'submit report', dueDay: '2026-11-30' },
      'submit report',
    ],
    ['pls call bnk tmrw', { title: 'Call the bank', dueDay: '2026-11-18' }, 'Call the bank'],
    ['fix it', { title: 'fix it' }, 'fix it'],
    ['at 9am', { dueTime: '09:00' }, 'at 9am'],
  ];
  it.each(typed)('%s → %j', (line, over, want) => expect(title(line, over)).toBe(want));

  it('a title the notes took the overflow from stands', () => {
    const line = 'devcheck m call the bank typed at 1 am and also ' + 'more words '.repeat(10);
    expect(title(line, { title: 'devcheck m call the bank', notes: 'and also more words' })).toBe(
      'devcheck m call the bank',
    );
  });

  it('spoken lines too, with their own meta words', () => {
    expect(title('Remind me to call the bank at 5.', { title: 'call the bank' }, true)).toBe(
      'call the bank',
    );
    expect(
      title('remind me to call the bank typed at 5 PM', { title: 'call the bank' }, true),
    ).toBe('call the bank typed');
    expect(
      title('call mum at quarter past five', { title: 'call mum', dueTime: '05:15' }, true),
    ).toBe('call mum');
    expect(title('look at one of the leases', {}, true)).toBe('look at one of the leases');
    expect(
      title('call mum tomorrow morning', { title: 'call mum', dueDay: '2026-11-18' }, true),
    ).toBe('call mum');
    expect(title('stretch typed in 20 minutes', { title: 'stretch' }, true)).toBe('stretch typed');
    expect(title('water plants tonight', { title: 'water plants' }, true)).toBe('water plants');
    expect(
      title('Remind me tomorrow to call mum', { title: 'call mum', dueDay: '2026-11-18' }, true),
    ).toBe('call mum');
    expect(title('Remind me at 5 to call mum', { title: 'call mum' }, true)).toBe('call mum');
    expect(
      title(
        'remind me tomorrow at 9 am to water the ferns done',
        { title: 'water the ferns', dueDay: '2026-11-18' },
        true,
      ),
    ).toBe('water the ferns done');
    expect(title('Remind me about the dentist', { title: 'the dentist' }, true)).toBe(
      'the dentist',
    );
    expect(title('update the flat 2 lease at 2', { title: 'update the flat 2 lease' }, true)).toBe(
      'update the flat 2 lease',
    );
  });

  it('the day and time still land as before', () => {
    expect(parse('finish slides before 3pm', { dueDay: TODAY, dueTime: '15:00' })?.input).toEqual({
      title: 'finish slides',
      dueDay: TODAY,
      dueTime: '15:00',
    });
    expect(parse('devcheck m call the bank typed at 1 am', {})?.input).toEqual({
      title: 'devcheck m call the bank typed',
      dueDay: '2026-11-18',
      dueTime: '01:00',
    });
  });
});

describe('keepTitleWords', () => {
  const none = { meta: [], tail: [], lead: null };
  it('stands when nothing changes or the words are reordered', () => {
    expect(keepTitleWords('fix  the bug', 'fix  the bug', none)).toBe('fix  the bug');
    expect(keepTitleWords('fix the bug', 'the bug fix', none)).toBe('the bug fix');
    expect(keepTitleWords('fix the bug', 'fix bugs', none)).toBe('fix bugs');
  });
  it('puts a dropped word back in place, the user’s spelling', () => {
    expect(keepTitleWords('Fix the LOGIN bug', 'fix bug', none)).toBe('Fix the LOGIN bug');
    expect(keepTitleWords('a b a c', 'a c', none)).toBe('a b a c');
  });
  it('never puts back a lone dash, and never leaves the title blank', () => {
    expect(keepTitleWords('fix - it', 'fix it', none)).toBe('fix it');
    expect(keepTitleWords('5pm', '5pm', { meta: [], tail: [[0, 3]], lead: null })).toBe('5pm');
  });
});
