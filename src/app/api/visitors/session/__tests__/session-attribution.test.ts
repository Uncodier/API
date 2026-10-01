import { normalizeSessionAttribution } from '../session-attribution';

const emptyAttribution = {
  utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
};

describe('normalizeSessionAttribution', () => {
  it('reads exactly the five allowed fields, decodes once, trims URL values and preserves case', () => {
    expect(normalizeSessionAttribution({
      url: 'https://example.com/?utm_source=%20Google%20&utm_medium=cpc&utm_campaign=Caf%C3%A9+Launch'
        + '&utm_term=one%2Btwo&utm_content=%2520&gclid=click&email=private%40example.com',
    })).toEqual({
      utm_source: 'Google', utm_medium: 'cpc', utm_campaign: 'Café Launch',
      utm_term: 'one+two', utm_content: '%20',
    });
  });

  it('does not mutate the input or re-decode explicit nonblank fields', () => {
    const input = Object.freeze({
      url: 'https://example.com/?utm_source=url-source&utm_medium=cpc&utm_campaign=launch',
      utm_source: ' Explicit%20Source ', utm_medium: '', utm_campaign: ' \t ',
    });
    expect(normalizeSessionAttribution(input)).toEqual({
      ...emptyAttribution, utm_source: ' Explicit%20Source ', utm_medium: 'cpc', utm_campaign: 'launch',
    });
  });

  it.each([undefined, '', ' ', 'not a URL', '/?utm_source=relative', 'https://[invalid',
    'javascript:alert(1)?utm_source=unsafe', 'data:text/plain,hello?utm_source=unsafe',
    'ftp://example.com/?utm_source=unsupported',
  ])('ignores missing, malformed or non-HTTP(S) URLs (%p) without losing explicit fields', url => {
    expect(normalizeSessionAttribution({ url })).toEqual(emptyAttribution);
    expect(normalizeSessionAttribution({ url, utm_source: 'explicit' })).toEqual({
      ...emptyAttribution, utm_source: 'explicit',
    });
  });

  it.each(['http', 'https'])('accepts %s landing URLs', protocol => {
    expect(normalizeSessionAttribution({ url: `${protocol}://example.com/?utm_source=source` }))
      .toEqual({ ...emptyAttribution, utm_source: 'source' });
  });

  it.each(['', '+', '%20%20', '%00bad', 'bad%0Avalue', 'bad%09value', '%7F', '%C2%85', '%E0%A4', '%FF'])(
    'ignores empty, control-character or malformed UTF-8 query values (%p)', value => {
      expect(normalizeSessionAttribution({ url: `https://example.com/?utm_source=${value}&utm_medium=cpc` }))
        .toEqual({ ...emptyAttribution, utm_medium: 'cpc' });
    },
  );

  it('returns null for absent fields and blank explicit fields without fallback', () => {
    expect(normalizeSessionAttribution({ utm_source: '', utm_medium: ' \t ' })).toEqual(emptyAttribution);
  });

  it('accepts 512 decoded characters but ignores overlong fields rather than truncating them', () => {
    const bounded = 'é'.repeat(512);
    expect(normalizeSessionAttribution({
      url: `https://example.com/?utm_source=${encodeURIComponent(bounded)}&utm_campaign=${'x'.repeat(513)}`,
    })).toEqual({ ...emptyAttribution, utm_source: bounded });
  });

  it('bounds fallback URL parsing at 8192 characters without affecting explicit values', () => {
    const prefix = 'https://example.com/?utm_source=url-source&padding=';
    const url = prefix + 'x'.repeat(8_192 - prefix.length);
    expect(normalizeSessionAttribution({ url })).toEqual({ ...emptyAttribution, utm_source: 'url-source' });
    expect(normalizeSessionAttribution({ url: `${url}x` })).toEqual(emptyAttribution);
    expect(normalizeSessionAttribution({ url: `${url}x`, utm_source: 'explicit' }))
      .toEqual({ ...emptyAttribution, utm_source: 'explicit' });
  });

  it('uses the first duplicate parameter, even when it is empty or unsafe', () => {
    expect(normalizeSessionAttribution({
      url: 'https://example.com/?utm_source=first&utm_source=second'
        + '&utm_medium=&utm_medium=cpc&utm_campaign=%00bad&utm_campaign=launch',
    })).toEqual({ ...emptyAttribution, utm_source: 'first' });
  });

  it('ignores fragment parameters, uppercase keys and nested URLs', () => {
    expect(normalizeSessionAttribution({
      url: 'https://example.com/?UTM_SOURCE=wrong&redirect=https%3A%2F%2Fother.example%2F%3Futm_medium%3Dcpc'
        + '#utm_campaign=fragment&utm_source=hash',
    })).toEqual(emptyAttribution);
  });
});