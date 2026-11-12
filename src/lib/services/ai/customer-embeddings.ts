import { customerMediaJson } from './customer-media-transport';
import { CustomerRoutingError } from './customer-routing';

/** The caller's existing embedding space is a constraint, never a model recommendation. */
export async function customerEmbeddings(input: string | string[], model: string, dimensions: number,
  options?: { timeout?: number; signal?: AbortSignal }) {
  const texts = Array.isArray(input) ? input : [input];
  if (!texts.length || texts.length > 2048 || texts.some(text => typeof text !== 'string' || !text.trim())
      || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65536) {
    throw new CustomerRoutingError('INVALID_EMBEDDING_INPUT');
  }
  return customerMediaJson({ capability: 'embedding', expectedModel: model, ...options,
    body: { input, dimensions, encoding_format: 'float', provider: { allow_fallbacks: false } },
    validate(data, selectedModel) {
      // Accept the documented vendor-unqualified alias, not a different embedding space.
      const actual = typeof data.model === 'string' ? data.model.trim() : '';
      if (!actual || (actual !== selectedModel && actual !== selectedModel.slice(selectedModel.indexOf('/') + 1))) {
        throw new Error('Embedding model mismatch');
      }
      if (!Array.isArray(data.data)) throw new Error('Missing vectors');
      const ordered = [...data.data].sort((a, b) => a?.index - b?.index);
      if (ordered.length !== texts.length || ordered.some((item, index) => !item || item.index !== index
          || !Array.isArray(item.embedding) || item.embedding.length !== dimensions
          || !item.embedding.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)))) {
        throw new Error('Invalid vectors');
      }
      return { embeddings: ordered.map(item => item.embedding as number[]), usage: data.usage, model: selectedModel };
    },
  });
}