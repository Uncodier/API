import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { ResearchEvidence } from '@/lib/services/requirement-evidence-types';
import { redactRuntimeSecrets } from './runtime-log-context';

/** Only stored delivery instructions may select this mode, never producer output. */
export function isReportOnlyTask(flow: string, item?: Partial<BacklogItem> | null, blocks: string[] = []): boolean {
  if (!['makinari', 'task'].includes(flow) || !item || item.touches?.length) return false;
  if (item.kind && !['doc', 'content', 'subtask', 'section', 'chapter', 'glossary'].includes(item.kind)) return false;
  const text = [...(item.constraints || []), ...(item.acceptance || []), ...blocks].join('\n');
  const claims = item.acceptance_contract?.criteria.flatMap(c => c.all_of) || [];
  if (claims.some(c => !['semantic_assertion', 'unsupported_obligation'].includes(c.kind))) return false;
  return /\bstep_output\b/i.test(text) && /\b(?:informe|report)\b/i.test(text) &&
    /\b(?:sin\s+c[oó]digo\s*\/\s*repositorio|no\s+(?:crear|generar)\s+archivos|no\s+code\s*\/\s*repo|no\s+(?:repository|repo|files)\b|without\s+(?:repository|files)\b)/i.test(text);
}

function object(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || redactRuntimeSecrets(value) !== value) return;
    url.hash = '';
    return url.toString();
  } catch { return; }
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? redactRuntimeSecrets(value).slice(0, limit) : '';
}

/** Collect only correlated successful host tool results. Search snippets are sources, not proof of claims. */
export function collectResearchEvidence(params: {
  requirementId: string; itemId: string; planId: string; stepId: string;
  executionGeneration: number; result: any; previous?: ResearchEvidence;
}): ResearchEvidence | undefined {
  const prior = params.previous;
  const reusable = prior?.requirement_id === params.requirementId && prior.item_id === params.itemId &&
    prior.plan_id === params.planId && prior.execution_generation === params.executionGeneration;
  const research: ResearchEvidence = {
    requirement_id: params.requirementId, item_id: params.itemId, plan_id: params.planId,
    execution_generation: params.executionGeneration,
    sources: reusable ? [...prior.sources] : [], reports: reusable ? [...prior.reports] : [],
  };
  for (const step of (Array.isArray(params.result?.steps) ? params.result.steps : []).slice(-30)) {
    const results = new Map<string, any>((Array.isArray(step.toolResults) ? step.toolResults : [])
      .map((r: any) => [r.toolCallId, r]));
    for (const call of (Array.isArray(step.toolCalls) ? step.toolCalls : []).slice(-30)) {
      const id = call.id || call.toolCallId;
      if (typeof id !== 'string' || !id) continue;
      const result = results.get(id);
      if (!result || result.isError) continue;
      let payload = object(result.result ?? result.output ?? result.content);
      if (payload.success !== true || payload.error) continue;
      const args = object(call.args ?? call.input);
      const routed = call.toolName === 'tools' && args.action === 'call' && args.name === 'webSearch';
      if (routed) {
        payload = object(payload.result);
        if (payload.success !== true || payload.error) continue;
      }
      const captured_at = new Date().toISOString();
      if (call.toolName === 'webSearch' || routed) {
        for (const source of (Array.isArray(payload.results) ? payload.results : []).slice(0, 20)) {
          const url = sourceUrl(source?.url);
          const excerpt = text(source?.snippet, 2000);
          if (!url || !excerpt.trim()) continue;
          if (research.sources.some(s => s.tool_call_id === id && s.url === url)) continue;
          research.sources.push({ tool_call_id: id, tool_name: 'webSearch', step_id: params.stepId,
            captured_at, url, title: text(source.title, 300), excerpt });
        }
      }
      if (call.toolName === 'instance_plan' && args.action === 'execute_step' &&
        args.plan_id === params.planId && args.step_id === params.stepId && args.step_status === 'completed' &&
        typeof args.step_output === 'string' && args.step_output.trim()) {
        if (research.reports.some(r => r.tool_call_id === id)) continue;
        const redacted = redactRuntimeSecrets(args.step_output);
        research.reports = research.reports.filter(r => r.step_id !== params.stepId);
        research.reports.push({ tool_call_id: id, step_id: params.stepId, captured_at,
          text: redacted.slice(0, 48000), truncated: redacted.length > 48000 });
      }
    }
  }
  research.sources = Array.from(new Map(research.sources.map(s => [`${s.tool_call_id}:${s.url}`, s])).values()).slice(-60);
  research.reports = research.reports.slice(-4);
  return research.sources.length || research.reports.length ? research : undefined;
}

/** Structural admissibility only. This must NEVER be used as an approval verdict. */
export function reportEvidenceGap(research?: ResearchEvidence): string | null {
  const report = research?.reports.at(-1);
  if (!report?.text.trim()) return 'Missing actual report captured from step_output.';
  if (report.truncated) return 'The captured report is truncated; full report verification is unavailable.';
  const cited = new Set((report.text.match(/https:\/\/[^\s<>"\])]+/g) || []).map(sourceUrl).filter(Boolean));
  if (!research?.sources.some(s => cited.has(s.url) && s.excerpt.trim())) {
    return 'Missing successful source receipt cited by the report; text claims and invented URLs are not evidence.';
  }
  return null;
}