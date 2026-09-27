import { describe, expect, it } from 'vitest';
import { fmtMoney, fmtMoneyWhole, parseDollars } from './money';

describe('money', () => {
  it('formats cents', () => {
    expect(fmtMoney(123456)).toBe('$1,234.56');
    expect(fmtMoney(-2150)).toBe('-$21.50');
    expect(fmtMoney(0)).toBe('$0.00');
  });
  it('whole dollars round toward zero', () => {
    expect(fmtMoneyWhole(41299)).toBe('$412');
    expect(fmtMoneyWhole(-41299)).toBe('-$412');
  });
  it('parses typed dollars without floats', () => {
    expect(parseDollars('600')).toBe(60000);
    expect(parseDollars('$1,234.5')).toBe(123450);
    expect(parseDollars('0.07')).toBe(7);
    expect(parseDollars('12.345')).toBeNull();
    expect(parseDollars('-5')).toBeNull();
    expect(parseDollars('')).toBeNull();
  });
});
