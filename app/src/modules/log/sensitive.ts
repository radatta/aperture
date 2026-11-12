// "Looks sensitive" — the capture bar's Make-private nudge (docs/areas/log). Local and pure: no API,
// no model. A listed term counts only when no letter touches it on either side, so keyboard, pinned,
// leetcode, passed and pwned never fire, while "pw:", "pin 4821" and "password=" do. Bare code, key,
// pin, secret and token are left out on purpose — they're everyday words.
const TERMS = [
  'pass(?:-?words?|-?phrases?|-?codes?|wds?)',
  'pwd?',
  'pin(?:\\s*(?:code|number|no\\.?|is)|\\s*[:=#]|\\s*\\d)',
  '(?:access|verification|security|backup|recovery|unlock|door|gate|garage|alarm|auth(?:entication)?|2fa|one[- ]time)[- ]?codes?',
  'otp|totp|2fa|mfa',
  '(?:api|secret|private|ssh|gpg|pgp|licen[cs]e|product|recovery|encryption|access)[- ]?keys?',
  '(?:api|access|auth|bearer|refresh|device|agent|github|gitlab|gh|npm|slack)[- ]?tokens?',
  'secret\\s*[:=]',
  'credentials?|creds',
  'login\\s*[:=]',
  'ssn|social security',
  'cvv|cvc',
  'passport\\s*(?:number|no\\.?|#)',
  'credit card|card number|routing number|account number',
  'seed phrase|recovery phrase|mnemonic',
];

const SENSITIVE = new RegExp(`(?:^|[^a-z])(?:${TERMS.join('|')})(?![a-z])`, 'i');

export const looksSensitive = (text: string): boolean => SENSITIVE.test(text);
