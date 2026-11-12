import { describe, expect, it } from 'vitest';
import { looksSensitive } from './sensitive';

describe('looksSensitive', () => {
  it.each([
    'disk password is hunter2',
    'Password: x',
    'wifi pw: abc',
    'pwd=abc',
    'PIN 4821',
    'pin: 1234',
    'bank pin is 0000',
    'the api key is abc',
    'ssh key rotated',
    'verification code 882190',
    'garage code 1234',
    'SSN ends 1234',
    'new passcode',
    'passwords changed',
    'backup codes saved',
    'seed phrase in the safe',
    'card number on file',
    'github token rotated',
    'creds for the nas',
    '2FA reset',
  ])('flags %j', (text) => expect(looksSensitive(text)).toBe(true));

  it.each([
    'pinned the PR',
    'new keyboard',
    'leetcode after lunch',
    'code review done',
    'key insight from standup',
    'passed the exam',
    'spinning up the VM',
    'compass app',
    'pwned list article',
    'shipped it',
    'pin this for later',
    'keynote prep',
    'token ring trivia',
    'secret santa',
    'opinion piece',
    '',
  ])('leaves %j alone', (text) => expect(looksSensitive(text)).toBe(false));
});
