import { formatWebSearchPayload } from '../webSearch-format';

describe('formatWebSearchPayload', () => {
  it('keeps the Tavily answer but always lists title + url', () => {
    const payload = formatWebSearchPayload({
      answer: 'AMPI is the main real-estate association in Mexico.',
      results: [
        {
          title: 'AMPI',
          url: 'https://ampi.org.mx',
          content: 'Asociación Mexicana de Profesionales Inmobiliarios',
        },
      ],
    });
    expect(payload.answer).toContain('AMPI');
    expect(payload.results[0].url).toBe('https://ampi.org.mx');
    expect(payload.text).toContain('https://ampi.org.mx');
    expect(payload.text).toContain('AMPI is the main');
  });

  it('does not drop URLs when an answer exists', () => {
    const payload = formatWebSearchPayload({
      answer: 'Generic summary without links.',
      results: [{ title: 'r/growmybusiness', url: 'https://reddit.com/r/growmybusiness' }],
    });
    expect(payload.text).toContain('https://reddit.com/r/growmybusiness');
  });
});
