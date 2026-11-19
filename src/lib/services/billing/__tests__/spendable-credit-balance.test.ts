import { spendableCreditBalance } from '../spendable-credit-balance';

describe('spendableCreditBalance', () => {
  it.each([
    [0, 39.22, 39.22], [0.04, 0.06, 0.1], [0.7, 0.1, 0.8], [0.1, 0.2, 0.3], [1, null, 1], [0, 0, 0],
    [10, -3, 7], [1, -3, -2], [0, 0.000000001, 0.000000001],
  ])('combines regular %s and wallet %s as %s', (credits_available, account_balance, expected) => {
    expect(spendableCreditBalance({ credits_available, account_balance })).toBe(expected);
  });
  it.each([undefined, NaN, Infinity, -Infinity, '10', false, {}, []])('rejects invalid wallet %s', account_balance => {
    expect(spendableCreditBalance({ credits_available: 10, account_balance })).toBeNull();
  });
  it.each([null, undefined, -1, NaN, Infinity, '10', false])('rejects invalid regular credits %s', credits_available => {
    expect(spendableCreditBalance({ credits_available, account_balance: 39.22 })).toBeNull();
  });
  it('rejects missing records and combined overflow', () => {
    expect(spendableCreditBalance(null)).toBeNull();
    expect(spendableCreditBalance(undefined)).toBeNull();
    expect(spendableCreditBalance({ credits_available: Number.MAX_VALUE, account_balance: Number.MAX_VALUE })).toBeNull();
  });
});