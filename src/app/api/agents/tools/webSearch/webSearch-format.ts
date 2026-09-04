export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export function formatWebSearchPayload(data: {
  answer?: string;
  results?: Array<{ content?: string; title?: string; url?: string }>;
}): { results: WebSearchHit[]; answer?: string; text: string } {
  const results: WebSearchHit[] = (data.results || [])
    .map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.url || '').trim(),
      snippet: String(r.content || '').trim().slice(0, 280),
    }))
    .filter((r) => r.url || r.title);

  const answer = data.answer?.trim() || undefined;
  const lines = results.map((r) => {
    const head = [r.title || 'Result', r.url].filter(Boolean).join(' — ');
    return r.snippet ? `- ${head}\n  ${r.snippet}` : `- ${head}`;
  });
  const text = [answer, lines.join('\n')].filter(Boolean).join('\n\n') || 'No results found.';
  return { results, answer, text };
}
