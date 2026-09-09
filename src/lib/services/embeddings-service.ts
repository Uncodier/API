import Portkey from 'portkey-ai';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    console.warn(`[embeddings service] Missing environment variable ${name}`);
  }
  return value;
}

export class EmbeddingsService {
  /**
   * Generates embeddings for a single string or an array of strings.
   */
  static async generateEmbeddings(
    input: string | string[],
    modelId: string = DEFAULT_MODEL,
    dimensions: number = DEFAULT_DIMENSIONS
  ): Promise<{ embeddings: number[][]; usage?: any }> {
    const apiKey = getEnv('PORTKEY_API_KEY');
    const virtualKey = getEnv('AZURE_OPENAI_API_KEY');

    if (!apiKey || !virtualKey) {
      throw new Error('Portkey embeddings are not configured');
    }

    const portkey = new Portkey({
      apiKey,
      virtualKey,
      baseURL: 'https://api.portkey.ai/v1',
    });

    console.log(`[embeddings service] Creating embeddings with model ${modelId} via Portkey`);

    const response = await portkey.embeddings.create({
      input,
      model: modelId,
      dimensions,
    });

    const embeddings = (response.data || [])
      .map((item) => item?.embedding)
      .filter((vector): vector is number[] => Array.isArray(vector));

    if (embeddings.length === 0) {
      console.error('[embeddings service] Portkey returned no valid vectors:', response);
      throw new Error('Portkey did not return a valid embedding');
    }

    return {
      embeddings,
      usage: response.usage,
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
