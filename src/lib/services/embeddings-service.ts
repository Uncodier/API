import { createOpenRouterClient, resolveOpenRouterModel } from './ai/openrouter';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export class EmbeddingsService {
  /**
   * Generates embeddings for a single string or an array of strings.
   */
  static async generateEmbeddings(
    input: string | string[],
    modelId: string = DEFAULT_MODEL,
    dimensions: number = DEFAULT_DIMENSIONS
  ): Promise<{ embeddings: number[][]; usage?: any; model: string }> {
    const model = resolveOpenRouterModel(modelId);
    const client = createOpenRouterClient();
    const response = await client.embeddings.create({
      input,
      model,
      dimensions,
      encoding_format: 'float',
    });

    // Preserve batch input order and reject partial/malformed vectors before storage.
    const expectedCount = Array.isArray(input) ? input.length : 1;
    const ordered = [...(response.data || [])].sort((a, b) => a.index - b.index);
    if (ordered.length !== expectedCount || ordered.some((item, index) => (
      item.index !== index || !Array.isArray(item.embedding)
      || item.embedding.length !== dimensions || !item.embedding.every(Number.isFinite)
    ))) {
      throw new Error('OpenRouter returned invalid or incomplete embeddings');
    }

    return {
      embeddings: ordered.map((item) => item.embedding),
      usage: response.usage,
      model: response.model || model,
    };
  }

  /**
   * Calculates the cosine similarity between two vectors.
   */
  static cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
