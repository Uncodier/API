import { describe, expect, it, jest } from '@jest/globals';
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));
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
    expect(out).toHaveProperty('results.0.url', 'https://ampi.org.mx');
  });
});

describe('tools router error classification', () => {
  const parameters = {
    type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } },
  };

  it.each([
    'Image generation failed: Image API request failed (503): Invalid Azure image endpoint configuration. Check Azure image endpoint, credentials, deployment and API version; Azure inference was not submitted. No alternate provider was called.',
    'Image generation failed: Invalid Azure image deployment or API version configuration',
    'Image generation failed: Azure image generation is not configured; missing credentials in server configuration',
    'Image API request failed (503): Image request admission is temporarily unavailable; Azure inference was not submitted',
    'Azure image request failed (502): invalid upstream response',
    'Image API request failed or timed out; generation outcome may be uncertain; unexpected response',
  ])('does not attach schema retry advice to infrastructure failures: %s', async message => {
    const execute = jest.fn(async () => { throw new Error(message); });
    const router = toolsRouterTool([{ name: 'generate_image', description: 'Generate an image', parameters, execute }]);
    const out = await router.execute({ action: 'call', name: 'generate_image', args: JSON.stringify({ prompt: 'A red cube' }) });
    expect(out).toMatchObject({ success: false, name: 'generate_image', error: message });
    expect(out).not.toHaveProperty('parameters');
    expect(out).not.toHaveProperty('hint');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['prompt is required', 'n must be an integer between 1 and 4', 'Invalid tool arguments', 'Validation failed: expected string'])(
    'retains schema correction advice for argument errors: %s', async message => {
      const router = toolsRouterTool([{
        name: 'generate_image', description: 'Generate an image', parameters,
        execute: async () => { throw new Error(message); },
      }]);
      const out = await router.execute({ action: 'call', name: 'generate_image', args: '{}' });
      expect(out).toMatchObject({ success: false, error: message, parameters });
      expect(out).toHaveProperty('hint', 'The error looks schema-related. Retry with args matching the parameters schema above.');
    },
  );
});
