// "Looks sensitive" — the capture bar's Make-private nudge (docs/areas/log). Local and pure: no API,
// no model. A listed term counts only when no letter touches it on either side, so keyboard, pinned,
// leetcode, passed and pwned never fire, while "pw:", "pin 4821" and "password=" do. Bare code, key,
// pin, secret and token are left out on purpose — they're everyday words. A term that needs a ":" or "="
// after it checks that by lookahead, so "pwd=abc" still ends the term before the letters.
const TERMS = [
  'pass(?:-?words?|-?phrases?|-?codes?|wds?)',
  'pw',
  'pwd(?=\\s*[:=])',
  'pins?(?:\\s*(?:code|number|no\\.?|is)|(?=\\s*[:=#])|\\s*\\d)',
  'codes?\\s*[:#=]?\\s*\\d{4,}',
  '(?:access|verification|security|backup|recovery|unlock|door|gate|garage|alarm|2fa|one[- ]time)[- ]?codes?',
  'otp|totp|2fa',
  '(?:api|secret|private|ssh|gpg|pgp|licen[cs]e|product|recovery|encryption)[- ]?keys?',
  '(?:api|github|gitlab|gh|npm|slack|personal access)[- ]?tokens?',
  'secret(?=\\s*[:=])',
  'credentials?|creds',
  'login(?=\\s*[:=])',
  'ssn|social security',
  'cvv|cvc',
  'passport\\s*(?:number|no\\.?|#)',
  'card number|routing number|account number|iban',
  'seed phrase|recovery phrase',
];

const SENSITIVE = new RegExp(`(?:^|[^a-z])(?:${TERMS.join('|')})(?![a-z])`, 'i');

export const looksSensitive = (text: string): boolean => SENSITIVE.test(text);
