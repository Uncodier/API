import type { AcceptanceAnalysis } from '@/lib/services/requirement-acceptance';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

export function genericProofTerms(
  analysis: AcceptanceAnalysis,
): string[] {
  const stopWords = new Set([
    'accepts', 'creates', 'deletes', 'emits', 'loads', 'opens',
    'persists', 'redirects', 'rejects', 'renders', 'responds',
    'returns', 'saves', 'shows', 'stores', 'updates',
    'after', 'before', 'during', 'from', 'into', 'that', 'their',
    'these', 'this', 'those', 'when', 'where', 'which', 'with',
  ]);
  return Array.from(new Set(
    (analysis.text.toLowerCase().match(/[a-z0-9_-]{4,}/g) || [])
      .filter((term) => !stopWords.has(term)),
  ));
}

export function genericEvidenceReceipts(
  evidence: EvidenceRecord,
): string[] {
  return [
    ...(evidence.scenario_assertions || [])
      .filter((assertion) => assertion.pass)
      .map((assertion) =>
        assertion.kind === 'http_response'
          ? [
              assertion.method,
              assertion.target,
              assertion.actual_status,
            ].join('\n')
          : [
              assertion.assertion,
              assertion.actual ?? '',
            ].join('\n'),
      ),
    ...(evidence.observations || [])
      .filter((observation) => observation.disposition === 'pass')
      .map((observation) =>
        `${observation.target || ''}\n${observation.detail}`),
  ].filter(Boolean);
}
