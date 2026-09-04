import { describe, expect, it } from '@jest/globals';
import {
  hoistRoutedToolResult,
  isAlwaysOnToolName,
  toolsRouterTool,
} from '../assistantProtocol';

describe('tools router webSearch forwarding', () => {
  it('treats webSearch as first-class / always-on', () => {
    expect(isAlwaysOnToolName('webSearch')).toBe(true);
  });

  it('hoists results[{title,url,snippet}] so the caller does not only see the answer', () => {
    const hoisted = hoistRoutedToolResult({
      success: true,
      result: 'CANACAR focuses on freight associations.',
      results: [
        { title: 'CANACAR', url: 'https://canacar.mx', snippet: 'Cámara Nacional' },
      ],
      answer: 'CANACAR focuses on freight associations.',
    });
    expect(hoisted.results).toEqual([
      { title: 'CANACAR', url: 'https://canacar.mx', snippet: 'Cámara Nacional' },
    ]);
    expect(hoisted.answer).toContain('CANACAR');
  });

  it('forwards hoisted results on tools action=call', async () => {
    const router = toolsRouterTool([
      {
        name: 'webSearch',
        description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        execute: async () => ({
          result: 'Answer without urls',
          answer: 'Answer without urls',
          results: [{ title: 'AMPI', url: 'https://ampi.org.mx', snippet: 'inmobiliario' }],
        }),
      },
    ]);
    const out = await router.execute({
      action: 'call',
      name: 'webSearch',
      args: '{"query":"AMPI Mexico"}',
    });
    expect(out.success).toBe(true);
    expect(out.results[0].url).toBe('https://ampi.org.mx');
  });
});
