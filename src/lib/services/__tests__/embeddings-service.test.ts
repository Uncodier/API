import { EmbeddingsService } from '../embeddings-service';
import { createOpenRouterClient } from '../ai/openrouter';

jest.mock('../ai/openrouter', () => ({
  ...jest.requireActual('../ai/openrouter'),
  createOpenRouterClient: jest.fn(),
}));

describe('OpenRouter embeddings', () => {
  const create = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createOpenRouterClient).mockReturnValue({ embeddings: { create } } as any);
  });

  it('preserves the existing model, dimensions, batch ordering and actual usage cost', async () => {
    const first = Array(1536).fill(0.1);
    const second = Array(1536).fill(0.2);
    const usage = { prompt_tokens: 2, total_tokens: 2, cost: 0.000001 };
    create.mockResolvedValue({ data: [{ index: 1, embedding: second }, { index: 0, embedding: first }], usage });
    const result = await EmbeddingsService.generateEmbeddings(['one', 'two']);
    expect(create).toHaveBeenCalledWith({
      input: ['one', 'two'], model: 'openai/text-embedding-3-small', dimensions: 1536, encoding_format: 'float',
    });
    expect(result).toEqual({ embeddings: [first, second], usage, model: 'openai/text-embedding-3-small' });
  });

  it.each([
    { data: [] },
    { data: [{ index: 1, embedding: [0, 1] }] },
    { data: [{ index: 0, embedding: [0] }] },
    { data: [{ index: 0, embedding: [NaN, 1] }] },
    { data: [{ index: 0, embedding: [0, Infinity] }] },
  ])('rejects malformed vectors before storage: %j', async (response) => {
    create.mockResolvedValue(response);
    await expect(EmbeddingsService.generateEmbeddings('one', 'text-embedding-3-small', 2)).rejects.toThrow('invalid or incomplete');
  });

  it('propagates failures rather than using a different embedding model/account', async () => {
    create.mockRejectedValue(new Error('Quota exceeded'));
    await expect(EmbeddingsService.generateEmbeddings('one')).rejects.toThrow('Quota exceeded');
    expect(create).toHaveBeenCalledTimes(1);
  });
});