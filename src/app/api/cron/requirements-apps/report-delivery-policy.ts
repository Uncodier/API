import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import { isReportOnlyTask } from '../shared/research-report-evidence';

/** Whole requirement only. A single research item must never suppress delivery of mixed work. */
export function isReportOnlyRequirement(params: {
  flow: string;
  instructions?: string | null;
  items?: Partial<BacklogItem>[] | null;
  steps?: any[] | null;
}): boolean {
  if (!params.items?.length || !['task', 'makinari'].includes(params.flow)) return false;
  const steps = params.steps || [];
  if (steps.some(step => {
    const id = step.metadata?.backlog_item_id || step.backlog_item_id;
    return !params.items!.some(item => item.id === id) || !!step.test_command ||
      step.validation_targets?.length > 0 || ['frontend', 'backend', 'devops'].includes(step.role);
  })) return false;
  return params.items.every(item => !!item.id && !!item.kind && isReportOnlyTask(params.flow, item, [
    params.instructions || '',
    ...steps.filter(step => (step.metadata?.backlog_item_id || step.backlog_item_id) === item.id)
      .flatMap(step => [step.instructions || '', ...(Array.isArray(step.validation_rules) ? step.validation_rules : [])]),
  ]));
}