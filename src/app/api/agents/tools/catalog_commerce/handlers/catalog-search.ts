const MIN_TOKEN_LENGTH = 3;

function sanitizeSearchTerm(term: string): string {
  return term.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function splitSearchTokens(search: string): string[] {
  const phrase = sanitizeSearchTerm(search);
  if (!phrase) return [];

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of phrase.split(/[\s;:/]+/)) {
    const token = raw.replace(/[^\p{L}\p{N}-]/gu, '').toLowerCase();
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function buildCatalogSearchOrFilter(terms: string[]): string {
  return terms
    .map((term) => {
      const safe = sanitizeSearchTerm(term);
      return `name.ilike.%${safe}%,description.ilike.%${safe}%`;
    })
    .join(',');
}

export type CatalogSearchClauses = {
  phrase: string;
  tokens: string[];
  phraseFilter: string;
  tokenFilter: string | null;
};

export function buildCatalogSearchClauses(search: string): CatalogSearchClauses | null {
  const phrase = sanitizeSearchTerm(String(search || ''));
  if (!phrase) return null;

  const tokens = splitSearchTokens(phrase);
  const phraseFilter = buildCatalogSearchOrFilter([phrase]);
  const phraseLower = phrase.toLowerCase();
  const shouldFallback =
    tokens.length > 1 || (tokens.length === 1 && tokens[0] !== phraseLower);

  return {
    phrase,
    tokens,
    phraseFilter,
    tokenFilter: shouldFallback ? buildCatalogSearchOrFilter(tokens) : null,
  };
}

export function catalogSearchFallbackHint(phrase: string, tokens: string[]): string {
  return `No exact match for '${phrase}'. Showing items matching: ${tokens.join(', ')}.`;
}
