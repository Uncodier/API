import { readQueryVector } from '@/app/api/agents/tools/router/search-context';
import { CONNECTOR_DOMAINS } from './domains';
import type { ReviewedConnectorTool } from './reviewed-tools';

// Search vocabulary is discovery metadata, never a registry of permitted actions.
const terms: Readonly<Record<string, string>> = {
  GMAIL_FETCH_EMAILS: 'inbox mail messages correo correos electrónicos bandeja de entrada mensajes',
  HUBSPOT_LIST_CONTACTS: 'address book contacts lista de contactos clientes CRM',
  SUPABASE_LIST_TABLES: 'table tables schema schemas metadata PostgreSQL database tables inventory tablas esquemas inventario de tablas base de datos',
};
const noise = new Set('the a an from for in of to de del el la las los en mi mis por para con que se un una hay quiero'.split(' '));
function tokens(text: string): Set<string> {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return new Set(normalized.split(/[^a-z0-9]+/).filter(word => word.length > 1 && !noise.has(word)));
}
function document(tool: ReviewedConnectorTool) {
  const aliases = CONNECTOR_DOMAINS.filter(domain => tool.domains.includes(domain.id)).flatMap(domain => domain.aliases);
  return [tool.slug, tool.toolkit, tool.description, tool.category, ...aliases, terms[tool.slug]].filter(Boolean).join('\n');
}

/** Input must already be filtered by current account policy, screens and scopes.
 * The cache contains only static reviewed documents, never account refs or grants. */
export function createActionRanker() {
  const cached = new Map<string, Promise<number[] | undefined>>();
  return async (eligible: ReviewedConnectorTool[], query?: string) => {
    const scores = new Map<string, number>();
    const words = tokens(query ?? '');
    const docs = [...new Set(eligible)].map(tool => ({ tool, text: document(tool) }));
    for (const { tool, text } of docs) {
      const vocabulary = tokens(text);
      const matches = [...words].filter(word => vocabulary.has(word)).length;
      const exact = query?.trim().toUpperCase() === tool.slug;
      scores.set(tool.slug, !query?.trim() ? 1 : (exact ? 10 : 0) + matches / Math.max(words.size, 1));
    }
    const embedding = query ? readQueryVector(query) : undefined;
    if (!embedding || !docs.length) return scores; // Direct gateway / native vector outage: local keywords only.
    try {
      const { EmbeddingsService } = await import('@/lib/services/embeddings-service');
      const key = (text: string) => JSON.stringify([embedding.model, embedding.vector.length, text]);
      const missing = docs.filter(({ text }) => !cached.has(key(text)));
      if (missing.length) {
        const batch = EmbeddingsService.generateEmbeddings(missing.map(doc => doc.text), undefined, undefined, { timeout: 1500 });
        missing.forEach(({ text }, i) => cached.set(key(text), batch.then(result => {
          const v = result.embeddings[i];
          if (result.model === embedding.model && v?.length === embedding.vector.length) return v;
        }).catch(() => undefined).then(v => {
          if (!v) cached.delete(key(text));
          return v;
        })));
      }
      for (const { tool, text } of docs) {
        const vector = await cached.get(key(text));
        if (!vector) continue;
        const cosine = EmbeddingsService.cosineSimilarity(embedding.vector, vector);
        if (cosine > 0.7) scores.set(tool.slug, scores.get(tool.slug)! + cosine);
      }
    } catch { /* An unavailable index does not remove exact/keyword matches. */ }
    return scores;
  };
}
