import { sumCreditBalances } from '../credit-balance-sum';

describe('decimal JSON credit projections', () => {
  it.each([
    [[.7, .1], .8], [[.1, .2, -.3], 0], [[-.7, -.1], -.8],
    [[1e-7, 2e-7], 3e-7], [[1e21, 1e21], 2e21],
    [[.000000000000001, -.000000000000002], -.000000000000001],
    [[.3, -.1, -.2, 39.22], 39.22], [[-0, 0], 0],
    [[1, -.9999999999999999], 1e-16],
  ])('sums %j as %s without introducing binary addition error', (values, expected) => {
    expect(sumCreditBalances(...values)).toBe(expected);
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite %s', value => {
    expect(sumCreditBalances(value, 1)).toBeNaN();
  });
  it('does not hide missing input or overflow', () => {
    expect(sumCreditBalances()).toBeNaN();
    expect(sumCreditBalances(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Infinity);
  });
});