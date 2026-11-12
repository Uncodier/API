import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { getExecutionRouting, resolveCustomerDispatch, CustomerRoutingError } from '../customer-routing';
import { recordCustomerInference } from '../../billing/customer-inference-receipts';
import { generateCustomerImageArtifacts } from '../customer-images';
import { validateCustomerPng } from '../customer-image-artifact';
import { EmbeddingsService } from '../../embeddings-service';
import { createOpenRouterClient } from '../openrouter';

jest.mock('../customer-routing', () => ({
  ...jest.requireActual('../customer-routing'), getExecutionRouting: jest.fn(), resolveCustomerDispatch: jest.fn(),
}));
jest.mock('../../billing/customer-inference-receipts', () => ({
  ...jest.requireActual('../../billing/customer-inference-receipts'), recordCustomerInference: jest.fn(),
  beginCustomerInference: jest.fn(async input => input.eventId),
}));
jest.mock('../openrouter', () => ({ ...jest.requireActual('../openrouter'), createOpenRouterClient: jest.fn() }));

function png(width = 1, filter = 0): string {
  const chunk = (type: string, payload: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), payload]); let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(1 + width * 3); raw[0] = filter;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

describe('customer media: offline dispatch and artifact contracts', () => {
  const key = randomBytes(24).toString('hex');
  const routing = { payer: 'customer' as const, siteId: 'site', connectionId: 'connection', policyVersion: 1, credentialVersion: 1 };
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getExecutionRouting).mockReturnValue(routing);
    jest.mocked(resolveCustomerDispatch).mockResolvedValue({ apiKey: key, modelId: 'openai/text-embedding-3-small', contextLength: 8192 });
    jest.mocked(recordCustomerInference).mockResolvedValue(undefined);
    global.fetch = jest.fn();
  });
  afterAll(() => { global.fetch = originalFetch; });

  it('routes embeddings with the ephemeral customer key and exact index binding, never global client', async () => {
    jest.mocked(global.fetch).mockResolvedValue(Response.json({ model: 'text-embedding-3-small',
      data: [{ index: 1, embedding: [2, 3] }, { index: 0, embedding: [0, 1] }], usage: { cost: 0 } }));
    const result = await EmbeddingsService.generateEmbeddings(['a', 'b'], 'text-embedding-3-small', 2);
    expect(result.embeddings).toEqual([[0, 1], [2, 3]]);
    expect(global.fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/embeddings', expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }));
    expect(createOpenRouterClient).not.toHaveBeenCalled();
    expect(recordCustomerInference).toHaveBeenCalledWith(expect.objectContaining({ routing, capability: 'embedding', usage: { cost: 0 } }));
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('rejects selected embedding model changes before dispatch', async () => {
    jest.mocked(resolveCustomerDispatch).mockResolvedValue({ apiKey: key, modelId: 'other/space', contextLength: 8192 });
    await expect(EmbeddingsService.generateEmbeddings('a')).rejects.toMatchObject({ code: 'CUSTOMER_MODEL_BINDING_MISMATCH' });
    expect(global.fetch).not.toHaveBeenCalled(); expect(createOpenRouterClient).not.toHaveBeenCalled();
  });

  it.each([null, 1])('rejects absent or insufficient selected-model context (%s) before dispatch', async contextLength => {
    jest.mocked(resolveCustomerDispatch).mockResolvedValue({ apiKey: key, modelId: 'openai/text-embedding-3-small', contextLength });
    await expect(EmbeddingsService.generateEmbeddings('test')).rejects.toMatchObject({ code: 'CUSTOMER_EMBEDDING_CONTEXT_UNVERIFIED' });
    expect(global.fetch).not.toHaveBeenCalled(); expect(recordCustomerInference).not.toHaveBeenCalled();
  });

  it('bounds the serialized embedding request before dispatch', async () => {
    await expect(EmbeddingsService.generateEmbeddings('a'.repeat(4 * 1024 * 1024))).rejects.toMatchObject({ code: 'CUSTOMER_REQUEST_TOO_LARGE' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'other/space', data: [{ index: 0, embedding: [0, 1] }] },
    { model: 'text-embedding-3-small', data: [{ index: 0, embedding: [0] }] },
    { model: 'text-embedding-3-small', data: [{ index: 0, embedding: ['0', 1] }] },
    { error: { message: 'secret upstream data' } },
  ])('fails closed malformed embedding output without replay', async response => {
    jest.mocked(global.fetch).mockResolvedValue(Response.json(response));
    await expect(EmbeddingsService.generateEmbeddings('a', 'text-embedding-3-small', 2)).rejects.toThrow('do not replay');
    expect(global.fetch).toHaveBeenCalledTimes(1); expect(createOpenRouterClient).not.toHaveBeenCalled();
    expect(recordCustomerInference).toHaveBeenCalledWith(expect.objectContaining({ uncertain: true }));
  });

  it('records uncertain network failure once and never retries on another account', async () => {
    jest.mocked(global.fetch).mockRejectedValue(new Error(key));
    await expect(EmbeddingsService.generateEmbeddings('a')).rejects.toThrow('do not replay');
    expect(global.fetch).toHaveBeenCalledTimes(1); expect(recordCustomerInference).toHaveBeenCalledTimes(1);
  });

  it('does not release successful output when receipt persistence fails', async () => {
    jest.mocked(global.fetch).mockResolvedValue(Response.json({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: [0, 1] }] }));
    jest.mocked(recordCustomerInference).mockRejectedValue(new Error('receipt unavailable'));
    await expect(EmbeddingsService.generateEmbeddings('a', 'text-embedding-3-small', 2)).rejects.toThrow('receipt unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(1); expect(recordCustomerInference).toHaveBeenCalledTimes(1);
  });

  it('cannot dispatch unverified images even if catalog lists a candidate', async () => {
    jest.mocked(resolveCustomerDispatch).mockRejectedValue(new CustomerRoutingError('CUSTOMER_CAPABILITY_UNAVAILABLE'));
    await expect(generateCustomerImageArtifacts({ siteId: 'site', prompt: 'test' })).rejects.toThrow('fallback is prohibited');
    expect(global.fetch).not.toHaveBeenCalled(); expect(recordCustomerInference).not.toHaveBeenCalled();
  });

  it('accepts complete PNG from documented dedicated image response, not remote image URLs', async () => {
    jest.mocked(resolveCustomerDispatch).mockResolvedValue({ apiKey: key, modelId: 'vendor/image', contextLength: null });
    jest.mocked(global.fetch).mockResolvedValue(Response.json({ data: [{ b64_json: png(), media_type: 'image/png' }] }));
    const result = await generateCustomerImageArtifacts({ siteId: 'site', prompt: 'test' });
    expect(result.images).toEqual([{ b64_json: png(), media_type: 'image/png' }]);
    const [url, request] = jest.mocked(global.fetch).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(request!.body as string)).toMatchObject({ model: 'vendor/image', output_format: 'png', provider: { allow_fallbacks: false } });
  });

  it.each([
    { data: [] }, { data: [{ url: 'https://example.test/image.png' }] },
    { data: [{ b64_json: png(), media_type: 'image/svg+xml' }] },
    { data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }] },
  ])('rejects empty, URL-only and invalid image artifacts', async response => {
    jest.mocked(global.fetch).mockResolvedValue(Response.json(response));
    await expect(generateCustomerImageArtifacts({ siteId: 'site', prompt: 'test' })).rejects.toThrow('do not replay');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('validates PNG checksum, inflation, filter, dimensions and ratio', () => {
    expect(validateCustomerPng(png())).toBe(png());
    expect(() => validateCustomerPng(png(), '1024x1024')).toThrow('size mismatch');
    expect(() => validateCustomerPng(png(2), undefined, '1:1')).toThrow('ratio mismatch');
    expect(() => validateCustomerPng(png(1, 5))).toThrow('filter');
    const corrupt = Buffer.from(png(), 'base64'); corrupt[40] ^= 1;
    expect(() => validateCustomerPng(corrupt.toString('base64'))).toThrow('checksum');
  });
});