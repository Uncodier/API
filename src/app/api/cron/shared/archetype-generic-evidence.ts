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
    ...(evidence.tests || [])
      .filter((test) => test.exit_code === 0 && test.ran_after_changes)
      .map((test) => `${test.command}\n${test.output_tail}`),
    ...(evidence.scenarios || [])
      .filter((scenario) => scenario.pass)
      .map((scenario) => scenario.name),
    ...(evidence.observations || [])
      .filter((observation) => observation.disposition === 'pass')
      .map((observation) =>
        `${observation.target || ''}\n${observation.detail}`),
    ...(evidence.feature_coverage?.artifact_proofs || [])
      .filter((proof) => proof.exists && proof.outcome === 'pass')
      .map((proof) => proof.content_excerpt || ''),
  ].filter(Boolean);
}
