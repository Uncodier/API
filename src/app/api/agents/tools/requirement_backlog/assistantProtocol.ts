import { executeBacklogCore, type BacklogAction, type BacklogCoreParams } from './route';
import type { BacklogItemKind, BacklogItemStatus, BacklogItemTier } from '@/lib/services/requirement-backlog';

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
        requirement_id: { type: 'string', description: 'Requirement UUID (required).' },
        item_id: { type: 'string', description: 'Backlog item UUID. Highly recommended to provide this explicitly for start, complete, downgrade, log_assumption, mark_needs_review, set_status actions.' },
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
          description:
            'Observable acceptance statements the Judge checks against evidence. ' +
            'For tier=core items, EVERY entry must contain at least one EXECUTABLE anchor — ' +
            'otherwise the upsert is rejected (narrative-only acceptance is the #1 cause of ' +
            'infinite Judge-reject loops). Anchors recognized: HTTP verb (GET/POST/PUT/PATCH/DELETE), ' +
            'route starting with `/` (e.g. `/api/studios`), status code (`200`, `2xx`, `404`), ' +
            'or observable verb (returns, renders, inserts, creates, updates, deletes, ' +
            'redirects, persists, saves, responds, opens modal, shows the form/table/list). ' +
            'BAD: "Admin can configure max_capacity on studios". ' +
            'GOOD: "PATCH /api/studios/:id with { max_capacity: number } returns 200 and persists the value." ' +
            'If the work is genuinely narrative (landing copy, marketing polish), set tier=ornamental.',
        },
        touches: { type: 'array', items: { type: 'string' }, description: 'Files or file globs this item is expected to touch.' },
        scope_level: { type: 'string', enum: ['full', 'mvp', 'minimal'], description: 'Requested scope. Default full.' },
        tier: {
          type: 'string',
          enum: ['core', 'ornamental'],
          description: 'Functional tier. `core` = must-ship functional item (the Judge applies kind-specific hard contracts and rejects narrative-only acceptance). `ornamental` = polish / landing / nice-to-have (relaxed contracts, does not block requirement closure). Default `core`.',
        },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Item ids this depends on (must be done first).' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'critic_review', 'judge_review', 'done', 'needs_review', 'rejected'],
          description: 'Target status for set_status.',
        },
        reason: { type: 'string', description: 'Optional reason for set_status or mark_needs_review.' },
        assumption: { type: 'string', description: 'Assumption text for log_assumption.' },
        confirm_reopen: { type: 'boolean', description: 'Must be true to set_status out of done.' },
      },
      required: ['action', 'requirement_id'],
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
        tier: args.tier as BacklogItemTier | undefined,
        depends_on: args.depends_on,
        status: args.status as BacklogItemStatus | undefined,
        reason: args.reason,
        assumption: args.assumption,
        confirm_reopen: args.confirm_reopen,
      };
      return executeBacklogCore(params);
    },
  };
}
