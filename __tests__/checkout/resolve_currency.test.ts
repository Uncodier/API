import { resolveLineCurrency, normalizeCurrency } from '../../src/app/api/agents/tools/checkout/resolve-currency';

describe('resolveLineCurrency', () => {
  it('prefers the catalog item currency over the site', () => {
    expect(resolveLineCurrency('mxn', 'USD')).toBe('MXN');
  });

  it('uses site currency when the item has none', () => {
    expect(resolveLineCurrency(null, 'mxn')).toBe('MXN');
    expect(resolveLineCurrency('', 'EUR')).toBe('EUR');
  });

  it('falls back to USD when neither is set', () => {
    expect(resolveLineCurrency(null, '')).toBe('USD');
    expect(resolveLineCurrency(undefined)).toBe('USD');
  });
});

describe('normalizeCurrency', () => {
  it('uppercases and trims', () => {
    expect(normalizeCurrency(' mxn ')).toBe('MXN');
  });

  it('returns null for empty values', () => {
    expect(normalizeCurrency('')).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });
});
