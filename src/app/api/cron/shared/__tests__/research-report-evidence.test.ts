import { randomBytes } from 'node:crypto';
import { runCritic, runJudge } from '../archetype-runner';
import { toolCalls } from '../archetype-evidence';
import { collectResearchEvidence, reportEvidenceGap, isReportOnlyTask } from '../research-report-evidence';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';

const item: BacklogItem = {
  id: 'research', title: 'Research public sources', kind: 'doc', phase_id: 'report',
  acceptance: ['Compare market alternatives and explain limitations.'],
  constraints: ['Sin código/repositorio/carpetas. Entregar el informe en step_output.'],
  status: 'in_progress', attempts: 0, scope_level: 'full', tier: 'core',
};
const scope = { requirementId: 'req', itemId: item.id, planId: 'plan', stepId: 'step', executionGeneration: 2 };
function searchResult() {
  return { steps: [{ toolCalls: [{ id: 'search-1', toolName: 'webSearch', args: { query: 'public comparison' } }],
    toolResults: [{ toolCallId: 'search-1', result: { success: true, results: [
      { url: 'https://example.invalid/source', title: 'Public source', snippet: 'Evidence from the public source.' },
    ] } }] }] };
}
function reportResult(text = '## Findings\nPublic comparison with limitations. Source: https://example.invalid/source') {
  return { steps: [{ toolCalls: [{ id: 'report-1', toolName: 'instance_plan', args: {
    action: 'execute_step', plan_id: 'plan', step_id: 'step', step_status: 'completed', step_output: text,
  } }], toolResults: [{ toolCallId: 'report-1', result: { success: true, completion_requested: true } }] }] };
}
function captured() {
  const sources = collectResearchEvidence({ ...scope, result: searchResult() });
  return collectResearchEvidence({ ...scope, result: reportResult(), previous: sources })!;
}

describe('bounded research report evidence', () => {
  it('selects only explicit report-only task delivery, never application or repository work', () => {
    expect(isReportOnlyTask('makinari', item)).toBe(true);
    expect(isReportOnlyTask('task', item)).toBe(true);
    expect(isReportOnlyTask('app', item)).toBe(false);
    expect(isReportOnlyTask('makinari', { ...item, kind: 'api' })).toBe(false);
    expect(isReportOnlyTask('makinari', { ...item, touches: ['reports/result.md'] })).toBe(false);
    expect(isReportOnlyTask('makinari', { ...item, constraints: [] })).toBe(false);
    expect(isReportOnlyTask('makinari', { ...item, constraints: ['No code. Deliver report in step_output and publish repository.'] })).toBe(false);
  });

  it('retains actual report and correlated source evidence across turns', () => {
    const research = captured();
    expect(research.reports[0].text).toContain('## Findings');
    expect(research.sources[0]).toMatchObject({ tool_call_id: 'search-1', tool_name: 'webSearch', url: 'https://example.invalid/source' });
    expect(reportEvidenceGap(research)).toBeNull();
    expect(toolCalls({ schema_version: 1, item_id: item.id, captured_at: '', critic_passes: 0, research }))
      .toEqual([expect.objectContaining({ name: 'webSearch', ok: true })]);
  });

  it('accepts routed webSearch only with successful matching call and tool result', () => {
    const result = searchResult();
    result.steps[0].toolCalls[0] = { id: 'search-1', toolName: 'tools', args: { action: 'call', name: 'webSearch' } } as any;
    result.steps[0].toolResults[0].result = { success: true, name: 'webSearch', result: result.steps[0].toolResults[0].result } as any;
    expect(collectResearchEvidence({ ...scope, result })?.sources).toHaveLength(1);
    result.steps[0].toolResults[0].toolCallId = 'unrelated';
    expect(collectResearchEvidence({ ...scope, result })).toBeUndefined();
  });

  it('does not accept producer prose, failed searches, invented citations, or old execution evidence', () => {
    expect(collectResearchEvidence({ ...scope, result: { text: 'Research done, sources verified.' } })).toBeUndefined();
    const failed = searchResult();
    failed.steps[0].toolResults[0].result.success = false;
    expect(collectResearchEvidence({ ...scope, result: failed })).toBeUndefined();
    expect(reportEvidenceGap(collectResearchEvidence({ ...scope, result: reportResult() }))).toContain('source');
    const invented = reportResult('Report https://example.invalid/invented');
    invented.steps[0].toolCalls[0].id = 'report-2';
    invented.steps[0].toolResults[0].toolCallId = 'report-2';
    expect(reportEvidenceGap(collectResearchEvidence({ ...scope, result: invented, previous: captured() })))
      .toContain('source');
    expect(collectResearchEvidence({ ...scope, executionGeneration: 3, result: {}, previous: captured() })).toBeUndefined();
    expect(collectResearchEvidence({ ...scope, planId: 'other', result: {}, previous: captured() })).toBeUndefined();
    expect(collectResearchEvidence({ ...scope, stepId: 'other', result: reportResult() })).toBeUndefined();
    expect(collectResearchEvidence({ ...scope, result: reportResult('') })).toBeUndefined();
    const previous = captured();
    expect(collectResearchEvidence({ ...scope, result: reportResult(), previous })).toEqual(previous);
  });

  it('redacts before bounding, rejects credentialed sources, and flags truncated reports', () => {
    const secret = randomBytes(24).toString('hex');
    const username = randomBytes(12).toString('hex');
    const url = new URL('https://example.invalid/source');
    url.username = username; url.password = secret;
    const result = searchResult();
    result.steps[0].toolResults[0].result.results[0].url = url.toString();
    expect(collectResearchEvidence({ ...scope, result })).toBeUndefined();
    const research = collectResearchEvidence({ ...scope, result: reportResult(`password=${secret}\n${url}\n${'x'.repeat(70000)}`) })!;
    expect(JSON.stringify(research)).not.toContain(secret);
    expect(JSON.stringify(research)).not.toContain(username);
    expect(research.reports[0].text.length).toBeLessThanOrEqual(48000);
    expect(reportEvidenceGap(research)).toContain('truncated');
  });

  it('never approves a report claim alone or keyword overlap; reports semantic capability honestly', () => {
    const evidence = { schema_version: 1 as const, item_id: item.id, captured_at: '', critic_passes: 0, research: captured() };
    const judge = runJudge({ item, evidence, flow: 'makinari' });
    expect(judge).toMatchObject({ verdict: 'escalate', failure_kind: 'capability_gap' });
    expect(judge.reason).not.toMatch(/lint|markdown tool|HTTP|ship code/);
    expect(runJudge({ item, evidence: { ...evidence, research: undefined }, flow: 'makinari' }))
      .toMatchObject({ verdict: 'rejected', failure_kind: 'evidence_gap' });
    const critic = runCritic({ item, evidence: { ...evidence, changed_files: ['README.md'] }, flow: 'makinari' });
    expect(critic.suggestions.map(s => s.rule)).not.toEqual(expect.arrayContaining(['admin-only-commit', 'narrative-acceptance', 'no-markdown-lint', 'no-tool-calls']));
    expect(runJudge({ item, evidence, flow: 'app' }).verdict).not.toBe('approved');
    expect(runJudge({ item: { ...item, acceptance: [] }, evidence, flow: 'makinari' }).verdict).not.toBe('approved');
  });
});