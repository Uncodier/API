import {
  mergeVercelJsonHeaders,
  stripXFrameOptionsFromNextConfig,
  PREVIEW_FRAME_ANCESTORS,
} from '../ensure-preview-frame-ancestors';

describe('mergeVercelJsonHeaders', () => {
  it('creates vercel.json headers if file is empty or null', () => {
    const parsed = JSON.parse(mergeVercelJsonHeaders(null));
    const globalRule = parsed.headers.find((h: { source: string }) => h.source === '/(.*)');
    const csp = globalRule.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy');

    expect(csp.value).toBe(`frame-ancestors ${PREVIEW_FRAME_ANCESTORS}`);
    expect(
      globalRule.headers.find((h: { key: string }) => h.key.toLowerCase() === 'x-frame-options')
    ).toBeUndefined();
  });

  it('keeps unrelated vercel.json keys', () => {
    const original = JSON.stringify({
      crons: [{ path: '/api/cron', schedule: '0 0 * * *' }],
      regions: ['cdg1'],
    });
    const parsed = JSON.parse(mergeVercelJsonHeaders(original));
    expect(parsed.crons).toEqual([{ path: '/api/cron', schedule: '0 0 * * *' }]);
    expect(parsed.regions).toEqual(['cdg1']);
    expect(parsed.headers[0].source).toBe('/(.*)');
  });

  it('removes existing X-Frame-Options and preserves other headers', () => {
    const original = JSON.stringify({
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Custom', value: 'value' },
          ],
        },
      ],
    });
    const parsed = JSON.parse(mergeVercelJsonHeaders(original));
    const globalRule = parsed.headers.find((h: { source: string }) => h.source === '/(.*)');

    expect(
      globalRule.headers.find((h: { key: string }) => h.key.toLowerCase() === 'x-frame-options')
    ).toBeUndefined();
    expect(globalRule.headers.find((h: { key: string }) => h.key === 'X-Custom').value).toBe('value');
    expect(
      globalRule.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy')
    ).toBeDefined();
  });

  it('updates existing CSP frame-ancestors', () => {
    const original = JSON.stringify({
      headers: [
        {
          source: '/(.*)',
          headers: [
            {
              key: 'Content-Security-Policy',
              value: "default-src 'self'; frame-ancestors 'none'; img-src *",
            },
          ],
        },
      ],
    });
    const parsed = JSON.parse(mergeVercelJsonHeaders(original));
    const csp = parsed.headers[0].headers.find(
      (h: { key: string }) => h.key === 'Content-Security-Policy'
    );

    expect(csp.value).toContain("default-src 'self';");
    expect(csp.value).toContain("frame-ancestors 'self'");
    expect(csp.value).toContain('img-src *');
    expect(csp.value).not.toContain("frame-ancestors 'none'");
  });
});

describe('stripXFrameOptionsFromNextConfig', () => {
  it('removes DENY / SAMEORIGIN header entries', () => {
    const source = `
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      ]
    `;
    const next = stripXFrameOptionsFromNextConfig(source);
    expect(next).not.toMatch(/X-Frame-Options/i);
    expect(next).toContain('Content-Security-Policy');
  });
});
