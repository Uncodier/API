/** Versioned byte budget shared by source hashes and provider input. */
export const CATALOG_EMBEDDING_INPUT_BYTES = 7_000;

export function boundedCatalogEmbeddingInput(text: string): string {
  let bytes = 0;
  const characters: string[] = [];
  for (const character of text) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > CATALOG_EMBEDDING_INPUT_BYTES) break;
    characters.push(character); bytes += next;
  }
  return characters.join('');
}