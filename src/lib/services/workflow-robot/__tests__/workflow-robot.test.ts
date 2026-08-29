import { buildRunSteps } from '../graph';
import { matchesFilter } from '../filter';
import { listMcpCatalog } from '../mcp-catalog';
import { isCronDueInWindow } from '../cron-window';
import { buildWorkflowRetryContext, canRetryStep, formatWorkflowValidationPrompt } from '../retry';
import type { WorkflowGraphNode } from '../types';

function node(partial: Partial<WorkflowGraphNode> & { id: string; type: string }): WorkflowGraphNode {
  return {
    instance_id: 'inst',
    parent_node_id: null,
    prompt: { text: 'Do the thing' },
    settings: {},
    site_id: 'site',
    ...partial,
  };
}

describe('buildRunSteps', () => {
  test('orders children after parents and copies mcp + sandbox flags', () => {
    const nodes: WorkflowGraphNode[] = [
      node({
        id: 'b',
        type: 'wf-step',
        parent_node_id: 'a',
        prompt: { text: 'Update the lead' },
        settings: {
          title: 'Update lead',
          step: { requires_sandbox: false, mcp_actions: [{ tool: 'leads', action: 'update' }] },
        },
      }),
      node({
        id: 'a',
        type: 'wf-step',
        prompt: { text: 'Search the company' },
        settings: {
          title: 'Web search',
          step: { requires_sandbox: true, expected_output: '{ summary }' },
        },
      }),
      node({ id: 't', type: 'wf-trigger', settings: { trigger: { kind: 'db_event', table: 'leads' } } }),
    ];

    const steps = buildRunSteps(nodes);
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('Web search');
    expect(steps[0].requires_sandbox).toBe(true);
    expect(steps[0].metadata.node_id).toBe('a');
    expect(steps[1].title).toBe('Update lead');
    expect(steps[1].metadata.mcp_actions).toEqual([{ tool: 'leads', action: 'update' }]);
    expect(steps[0].max_retries).toBe(2);
    expect(steps[0].recovery_plan).toBe('');
    expect(steps[1].max_retries).toBe(2);
  });

  test('copies max_retries and recovery_plan from settings.step', () => {
    const nodes: WorkflowGraphNode[] = [
      node({
        id: 'a',
        type: 'wf-step',
        settings: {
          title: 'Search',
          step: {
            max_retries: 5,
            recovery_plan: 'If webSearch returns nothing, skip CRM write.',
          },
        },
      }),
    ];
    const steps = buildRunSteps(nodes);
    expect(steps[0].max_retries).toBe(5);
    expect(steps[0].recovery_plan).toBe('If webSearch returns nothing, skip CRM write.');
  });

  test('preserves max_retries of 0', () => {
    const nodes: WorkflowGraphNode[] = [
      node({
        id: 'a',
        type: 'wf-step',
        settings: { title: 'Once', step: { max_retries: 0 } },
      }),
    ];
    expect(buildRunSteps(nodes)[0].max_retries).toBe(0);
  });
});

describe('canRetryStep', () => {
  test('retries while retry_count is below max_retries', () => {
    expect(canRetryStep(0, 2)).toBe(true);
    expect(canRetryStep(1, 2)).toBe(true);
    expect(canRetryStep(2, 2)).toBe(false);
    expect(canRetryStep(3, 2)).toBe(false);
  });

  test('does not retry when max_retries is 0', () => {
    expect(canRetryStep(0, 0)).toBe(false);
    expect(canRetryStep(1, 0)).toBe(false);
  });
});

describe('buildWorkflowRetryContext', () => {
  const base = {
    errorMessage: 'webSearch timed out',
    retryCount: 1,
    maxRetries: 2,
    lastOutput: 'partial result',
    step: { id: 'step_1', order: 1, title: 'Search' },
    triggerSnippet: '{"id":"lead-1"}',
  };

  test('includes error, attempt, last output, and recovery_plan', () => {
    const text = buildWorkflowRetryContext({
      ...base,
      historyText: '',
      recoveryPlan: 'If webSearch returns nothing, skip CRM write.',
    });
    expect(text).toContain('PREVIOUS ATTEMPT FAILED');
    expect(text).toContain('webSearch timed out');
    expect(text).toContain('You MUST fix this error during this execution attempt.');
    expect(text).toContain('Attempt: 2 of 2');
    expect(text).toContain('partial result');
    expect(text).toContain('id=step_1');
    expect(text).toContain('lead-1');
    expect(text).toContain('RECOVERY PLAN (use this on retry, not the original approach unless it still applies):');
    expect(text).toContain('If webSearch returns nothing, skip CRM write.');
    expect(text).not.toContain('PREVIOUS ACTIONS IN THIS STEP');
  });

  test('omits recovery_plan and empty history', () => {
    const text = buildWorkflowRetryContext({
      ...base,
      lastOutput: '',
      historyText: '   ',
      recoveryPlan: '',
    });
    expect(text).toContain('PREVIOUS ATTEMPT FAILED');
    expect(text).not.toContain('RECOVERY PLAN');
    expect(text).not.toContain('PREVIOUS ACTIONS IN THIS STEP');
    expect(text).not.toContain('Last output from the failed attempt');
  });

  test('includes history when provided', () => {
    const text = buildWorkflowRetryContext({
      ...base,
      historyText: '--- PREVIOUS ACTIONS IN THIS STEP ---\n[Tool Call: webSearch]\n--- END PREVIOUS ACTIONS ---',
      recoveryPlan: '',
    });
    expect(text).toContain('[Tool Call: webSearch]');
  });
});

describe('formatWorkflowValidationPrompt', () => {
  test('returns empty when no criteria or rules', () => {
    expect(formatWorkflowValidationPrompt({}, (t) => t)).toBe('');
  });

  test('includes success_criteria and validation_rules', () => {
    const text = formatWorkflowValidationPrompt(
      {
        success_criteria: ['Lead has a domain'],
        validation_rules: [{ rule: 'company_name', required: true, value: '{{trigger.company}}' }],
      },
      (t) => t.replace('{{trigger.company}}', 'Acme'),
    );
    expect(text).toContain('Success criteria:');
    expect(text).toContain('Lead has a domain');
    expect(text).toContain('Validation rules:');
    expect(text).toContain('company_name = Acme');
    expect(text).toContain('(required)');
  });
});

describe('matchesFilter', () => {
  test('empty filter matches', () => {
    expect(matchesFilter({ status: 'new' })).toBe(true);
  });
  test('requires exact field match', () => {
    expect(matchesFilter({ status: 'new' }, { status: 'new' })).toBe(true);
    expect(matchesFilter({ status: 'lost' }, { status: 'new' })).toBe(false);
  });
});

describe('listMcpCatalog', () => {
  test('includes leads and webSearch', () => {
    const names = listMcpCatalog().map((t) => t.name);
    expect(names).toContain('leads');
    expect(names).toContain('webSearch');
  });
});

describe('isCronDueInWindow', () => {
  const windowMs = 120_000;
  const nineAmCdmx = Date.parse('2026-08-28T15:00:30.000Z');
  const nineAmUtc = Date.parse('2026-08-28T09:00:30.000Z');
  const tenThirtyUtc = Date.parse('2026-08-28T10:30:00.000Z');

  test('every-minute cron is due', () => {
    expect(isCronDueInWindow('* * * * *', Date.now(), windowMs)).toBe(true);
  });

  test('yearly cron far from last tick is not due', () => {
    const midYear = Date.parse('2026-06-15T12:00:00.000Z');
    expect(isCronDueInWindow('0 0 1 1 *', midYear, windowMs, 'UTC')).toBe(false);
  });

  test('daily 9am is due at 9:00 in America/Mexico_City', () => {
    expect(isCronDueInWindow('0 9 * * *', nineAmCdmx, windowMs, 'America/Mexico_City')).toBe(true);
  });

  test('daily 9am is not due at 15:00 UTC when tz is UTC', () => {
    expect(isCronDueInWindow('0 9 * * *', nineAmCdmx, windowMs, 'UTC')).toBe(false);
  });

  test('daily 9am is due at 09:00 UTC when tz is UTC', () => {
    expect(isCronDueInWindow('0 9 * * *', nineAmUtc, windowMs, 'UTC')).toBe(true);
  });

  test('hourly cron is not due 30 minutes after the tick', () => {
    expect(isCronDueInWindow('0 * * * *', tenThirtyUtc, windowMs, 'UTC')).toBe(false);
  });
});
