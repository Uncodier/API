import { executeBacklogCore, type BacklogAction, type BacklogCoreParams } from './route';
import type { BacklogItemKind, BacklogItemStatus, BacklogItemTier } from '@/lib/services/requirement-backlog';
import { BACKLOG_LIST_STATUSES } from '@/lib/services/requirement-backlog-view';

const acceptanceClaimSchema = {
  type: 'object',
  description:
    'Typed acceptance claim. Required fields by kind: http_response => path, method, auth; ' +
    'page_response => path; internal_link => requires_content; file_artifact => path; ' +
    'command => command; semantic_assertion => text.',
  properties: {
    kind: {
      type: 'string',
      enum: [
        'http_response',
        'page_response',
        'internal_link',
        'file_artifact',
        'command',
        'semantic_assertion',
      ],
    },
    path: {
      type: 'string',
      description:
        'Application route for response/link claims or repository-relative path for file_artifact.',
    },
    method: {
      type: 'string',
      enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    },
    expected_status: {
      type: 'string',
      description: 'Exact status such as 200 or class such as 2xx.',
    },
    auth: {
      type: 'string',
      enum: ['required', 'unspecified'],
    },
    region: {
      type: 'string',
      enum: ['header', 'footer', 'navigation', 'other'],
    },
    requires_content: { type: 'boolean' },
    command: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['kind'],
};

export function requirementBacklogTool(_siteId: string, defaultRequirementId?: string) {
  return {
    name: 'requirement_backlog',
    description:
      'Canonical backlog for a requirement. Every actionable work item lives here — Producer adds them, Consumer starts one (WIP=1), and the runner moves it through review to a terminal outcome. Model actions: list | get | upsert | start | downgrade | log_assumption | report_blocker | resolve_blocker | set_status. list is a read-only, paginated summary (open items by default, active first); get with item_id returns full acceptance, constraints, evidence and history. Always get the selected item before planning or modifying it. Check summary.total_items, not just backlog.items, before deciding the backlog is empty. Do not clone an existing task as a numbered remediation. report_blocker pauses only the affected item, propagates blocked_by to dependency descendants, and releases WIP so independent items can continue. It never blocks the whole requirement. Terminal transitions (done, rejected, needs_review) are runner-owned; finish plan work with instance_plan action="execute_step" so the gate and Judge can decide the outcome.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'get',
            'upsert',
            'start',
            'downgrade',
            'log_assumption',
            'report_blocker',
            'resolve_blocker',
            'set_status',
          ],
          description: 'Backlog operation to perform.',
        },
        requirement_id: { type: 'string', description: 'Requirement UUID (required).' },
        item_id: { type: 'string', description: 'Backlog item UUID. Required for get, start, downgrade, log_assumption, and set_status. Provide it on upsert to update existing work instead of duplicating it.' },
        list_status: {
          type: 'string', enum: [...BACKLOG_LIST_STATUSES],
          description: 'list only. Default open excludes done/rejected. all includes every status; use an exact status to filter. This is NOT a status transition.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list page size; default 20, maximum 50.' },
        offset: { type: 'integer', minimum: 0, description: 'list offset; default 0. Continue with pagination.next_offset when has_more is true.' },
        title: { type: 'string', description: 'Human-readable item title.' },
        kind: {
          type: 'string',
          description: 'Item kind (flow-specific). Examples: page, component, crud, api, auth, integration, doc, section, slide, clause, subtask, script, content, polish.',
        },
        phase_id: {
          type: 'string',
          description: 'Phase id from the flow registry (e.g. build, qa, validate, report). Must match the current flow.',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Human-readable acceptance statements. For tier=core items, also provide ' +
            'acceptance_contract with one typed executable claim for every entry. ' +
            'Do not embed implementation snippets and expect slash-based route inference; ' +
            'declare known routes in claims and use discovery for semantic behavior.',
        },
        acceptance_contract: {
          type: 'object',
          description:
            'Preferred typed interpretation of acceptance[]. Use schema_version=2 and source="declared". ' +
            'criteria must match acceptance[] in the same order. Explicit route claims are authoritative. ' +
            'For behavior without an explicit route, use semantic_assertion and include discovery.query plus ' +
            'a small hypothetical_code specimen; semantic retrieval only discovers candidates and never proves acceptance.',
          properties: {
            schema_version: { type: 'number', enum: [2] },
            source: { type: 'string', enum: ['declared'] },
            criteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  all_of: {
                    type: 'array',
                    items: acceptanceClaimSchema,
                  },
                  discovery: {
                    type: 'object',
                    properties: {
                      query: { type: 'string' },
                      hypothetical_code: { type: 'string' },
                      expected_symbols: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                    required: ['query', 'hypothetical_code'],
                  },
                },
                required: ['id', 'text', 'all_of'],
              },
            },
          },
          required: ['schema_version', 'source', 'criteria'],
        },
        touches: { type: 'array', items: { type: 'string' }, description: 'Files or file globs this item is expected to touch.' },
        scope_level: { type: 'string', enum: ['full', 'mvp', 'minimal'], description: 'Requested scope. Default full.' },
        tier: {
          type: 'string',
          enum: ['core', 'ornamental'],
          description: 'Functional tier. `core` = must-ship functional item (the Judge applies kind-specific hard contracts and rejects narrative-only acceptance). `ornamental` = polish / landing / nice-to-have (relaxed contracts, does not block requirement closure). Default `core`.',
        },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Item ids this depends on (must be done first).' },
        blocker_id: {
          type: 'string',
          description: 'Stable blocker id. Optional for report_blocker; required for resolve_blocker.',
        },
        blocker_category: {
          type: 'string',
          enum: [
            'product_defect',
            'infrastructure_unavailable',
            'missing_precondition',
            'evidence_gap',
            'contract_error',
            'user_decision',
          ],
          description: 'Typed reason preventing only this item from progressing.',
        },
        resolution_actor: {
          type: 'string',
          enum: ['executor', 'verifier', 'platform', 'user'],
          description: 'Who can resolve the blocker. Use user only for a concrete non-agentifiable decision or credential.',
        },
        source_step_id: { type: 'string', description: 'Optional plan step that produced the blocker.' },
        user_action_required: {
          type: 'boolean',
          description: 'True only when a concrete user response is required. Infrastructure and evidence gaps must be false.',
        },
        retry_after: { type: 'string', description: 'Optional ISO timestamp for an automatic retry.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'critic_review', 'judge_review'],
          description: 'Non-terminal target status for set_status. Terminal states are runner-owned.',
        },
        reason: { type: 'string', description: 'Optional reason for set_status.' },
        assumption: { type: 'string', description: 'Assumption text for log_assumption.' },
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
        list_status: args.list_status,
        limit: args.limit,
        offset: args.offset,
        title: args.title,
        kind: args.kind as BacklogItemKind | undefined,
        phase_id: args.phase_id,
        acceptance: args.acceptance,
        acceptance_contract: args.acceptance_contract,
        touches: args.touches,
        scope_level: args.scope_level,
        tier: args.tier as BacklogItemTier | undefined,
        depends_on: args.depends_on,
        status: args.status as BacklogItemStatus | undefined,
        reason: args.reason,
        assumption: args.assumption,
        blocker_id: args.blocker_id,
        blocker_category: args.blocker_category,
        resolution_actor: args.resolution_actor,
        source_step_id: args.source_step_id,
        user_action_required: args.user_action_required,
        retry_after: args.retry_after,
      };
      return executeBacklogCore(params);
    },
  };
}
