import { AsyncLocalStorage } from 'node:async_hooks';

type QueryVector = { model: string; vector: number[] };
const searches = new AsyncLocalStorage<{ query: string; embedding?: QueryVector }>();

// Reuse the native query embedding on its configured execution route. Never pass
// vectors through tool arguments, decorators, results, or persistent query caches.
export function withSearchContext<T>(query: string, run: () => T): T {
  return searches.run({ query: query.trim() }, run);
}

export function shareQueryVector(query: string, embedding: QueryVector) {
  const current = searches.getStore();
  if (current && current.query === query) current.embedding = embedding;
}

export function readQueryVector(query: string) {
  const current = searches.getStore();
  return current?.query === query.trim() ? current.embedding : undefined;
}
