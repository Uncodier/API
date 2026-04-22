import { executeBacklogCore, type BacklogAction, type BacklogCoreParams } from './route';
import type { BacklogItemKind, BacklogItemStatus } from '@/lib/services/requirement-backlog';

export function requirementBacklogTool(_siteId: string, defaultRequirementId?: string) {
  return {
    name: 'requirement_backlog',
    description:
      'Canonical backlog for a requirement. Every actionable work item lives here — Producer adds them, Consumer starts one (WIP=1), Critic/Judge move it through critic_review → judge_review → done. Actions: list | upsert | start | complete | downgrade | log_assumption | mark_needs_review | set_status. The tool rejects start when another item is already in_progress; downgrade drops scope_level full → mvp → minimal and resets status to pending.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'upsert',
            'start',
            'complete',
            'downgrade',
            'log_assumption',
            'mark_needs_review',
            'set_status',
          ],
          description: 'Backlog operation to perform.',
        },
        requirement_id: { type: 'string', description: 'Requirement UUID.' },
        item_id: { type: 'string', description: 'Backlog item UUID (optional on upsert to create a new item).' },
        title: { type: 'string', description: 'Human-readable item title.' },
        kind: {
          type: 'string',
          description: 'Item kind (flow-specific). Examples: page, component, crud, api, auth, integration, section, slide, clause, subtask, script, content, polish.',
        },
        phase_id: {
          type: 'string',
          description: 'Phase id from the flow registry (e.g. build, qa, validate, report). Must match the current flow.',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: 'Observable acceptance statements. The Judge checks these against evidence/<item_id>.json.',
        },
        touches: { type: 'array', items: { type: 'string' }, description: 'Files or file globs this item is expected to touch.' },
        scope_level: { type: 'string', enum: ['full', 'mvp', 'minimal'], description: 'Requested scope. Default full.' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Item ids this depends on (must be done first).' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'critic_review', 'judge_review', 'done', 'needs_review', 'rejected'],
          description: 'Target status for set_status.',
        },
        reason: { type: 'string', description: 'Optional reason for set_status or mark_needs_review.' },
        assumption: { type: 'string', description: 'Assumption text for log_assumption.' },
      },
      required: ['action'],
    },
    execute: async (args: Partial<BacklogCoreParams> & { action: BacklogAction }) => {
      const requirement_id = args.requirement_id || defaultRequirementId;
      if (!requirement_id) throw new Error('requirement_id is required');
      const params: BacklogCoreParams = {
        action: args.action,
        requirement_id,
        item_id: args.item_id,
        title: args.title,
        kind: args.kind as BacklogItemKind | undefined,
        phase_id: args.phase_id,
        acceptance: args.acceptance,
        touches: args.touches,
        scope_level: args.scope_level,
        depends_on: args.depends_on,
        status: args.status as BacklogItemStatus | undefined,
        reason: args.reason,
        assumption: args.assumption,
      };
      return executeBacklogCore(params);
    },
  };
}
