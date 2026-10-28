import { jest } from '@jest/globals';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { interpolateWorkflowText, formatWorkflowValidationPrompt } from '../retry';

function harness() {
  const getSkillBySlugOrName = jest.fn<(name: string) => { name: string; content: string } | null>()
    .mockReturnValue({ name: 'Workflow playbook', content: 'Use the declared output fields.' });
  const { buildWorkflowStepPrompt } = loadRuntimeModule<typeof import('../step-prompt')>(
    'src/lib/services/workflow-robot/step-prompt.ts', {
      '@/lib/services/skills-service': { SkillsService: { getSkillBySlugOrName } },
      './retry': { interpolateWorkflowText, formatWorkflowValidationPrompt },
    },
  );
  return { buildWorkflowStepPrompt, getSkillBySlugOrName };
}

const params = {
  plan: { id: 'plan-local' },
  step: {
    id: 'step-local', order: 2, title: 'Summarize', skill: 'assigned-local',
    instructions: 'Summarize {{trigger.topic}} using {{steps.first.summary}}.',
    expected_output: '{ "summary": "{{trigger.topic}}" }',
    success_criteria: ['Cite {{trigger.topic}}'],
    validation_rules: [{ rule: 'summary', value: '{{trigger.topic}}', required: true }],
    metadata: { mcp_actions: [{ tool: 'content', action: 'read', hint: 'Use authorized content' }] },
  },
  dryRun: false, triggerPayload: { topic: 'Local subject' },
  previousOutputs: { first: { summary: 'Known findings' } },
  instanceId: 'instance-local', siteId: 'site-local',
  relationPrompt: 'Continue only if {{steps.first.summary}} satisfies the relation.',
  retryContext: '\nExisting retry context: inspect the previous receipt before acting.',
};

describe('buildWorkflowStepPrompt contracts (offline, no environment)', () => {
  it('preserves identity, interpolation, relations, retry context, criteria and loaded skill', () => {
    const h = harness();
    const prompt = h.buildWorkflowStepPrompt(params);
    expect(h.getSkillBySlugOrName).toHaveBeenCalledWith('assigned-local');
    for (const value of ['plan-local', 'Step ID: step-local', 'instance-local', 'site-local',
      'Summarize Local subject using Known findings.', '{ "summary": "Local subject" }',
      'Continue only if Known findings satisfies the relation.', 'Cite Local subject',
      'summary = Local subject (required)', 'content action=read: Use authorized content',
      'Use the declared output fields.', params.retryContext]) {
      expect(prompt).toContain(value);
    }
    expect(prompt).toContain(JSON.stringify(params.triggerPayload, null, 2));
    expect(prompt).toContain(JSON.stringify(params.previousOutputs, null, 2));
    expect(prompt).not.toContain('{{');
  });

  it('allows proportional planning and advisory improvement without changing terminal obligations', () => {
    const prompt = harness().buildWorkflowStepPrompt(params);
    for (const clause of ['Plan proportionally', 'Additional skill discovery is optional',
      'Review is advisory, not a veto or a new gate', 'Explicit criteria and validation rules remain binding',
      'Improvement does not reset retries', 'not private internal reasoning',
      'Do NOT create or update instance_plan or requirements', 'Do NOT plan work outside this step',
      'Your step is not complete until you call the direct `plan_result` tool',
      'pass/fail entry for every declared criterion and validation rule',
      'status="failed" and a concrete error', 'Plain text is not a completion signal']) {
      expect(prompt).toContain(clause);
    }
    expect(prompt).not.toContain('Do NOT plan new work.');
    expect(prompt).not.toContain('thought_process');
    expect(prompt).not.toContain('MUST CANCEL');
  });

  it('reports missing explicit skill and input without making up a workflow or sending a message', () => {
    const h = harness();
    h.getSkillBySlugOrName.mockReturnValue(null);
    const prompt = h.buildWorkflowStepPrompt(params);
    expect(prompt).toContain('Assigned skill unavailable: assigned-local');
    expect(prompt).toContain('do not invent its instructions or create a replacement workflow');
    expect(prompt).toContain('report the precise missing input through plan_result');
    expect(prompt).toContain('rather than guessing or sending an unauthorized clarification message');
    expect(prompt).not.toContain('skill_lookup');
  });

  it('retains the existing default workflow playbook without claiming it was explicitly selected', () => {
    const h = harness();
    const input = { ...params, step: { ...params.step, skill: undefined } };
    expect(h.buildWorkflowStepPrompt(input)).toContain('Use the declared output fields.');
    expect(h.getSkillBySlugOrName).toHaveBeenCalledWith('makinari-rol-workflow-step');
    h.getSkillBySlugOrName.mockReturnValue(null);
    expect(h.buildWorkflowStepPrompt(input)).not.toContain('Assigned skill unavailable');
  });

  it('preserves LIVE execution, required tool calls and no-sandbox restrictions', () => {
    const prompt = harness().buildWorkflowStepPrompt(params);
    expect(prompt).toContain('EXECUTION MODE: LIVE (real)');
    expect(prompt).toContain('Do NOT simulate, mock, skip tools');
    expect(prompt).toContain('For steps that match their incoming relation you MUST call tools');
    expect(prompt).toContain('This step has NO sandbox. Do not call sandbox_* tools.');
  });

  it('preserves DRY RUN restrictions without retaining LIVE instructions', () => {
    const prompt = harness().buildWorkflowStepPrompt({ ...params, dryRun: true });
    expect(prompt).toContain('EXECUTION MODE: DRY RUN (test)');
    expect(prompt).toContain('do NOT persist CRM/data writes or send messages');
    expect(prompt).toContain('"execution_mode": "dry_run" in plan_result.data');
    expect(prompt).not.toContain('EXECUTION MODE: LIVE');
    expect(prompt).not.toContain('you MUST call tools');
  });

  it('allows a context-only result only under the host-selected v2 contract while preserving required effects', () => {
    const prompt = harness().buildWorkflowStepPrompt({ ...params, resultContractVersion: 2 });
    expect(prompt).toContain('Tool activity alone is not a success criterion');
    expect(prompt).toContain('every explicitly required action and evidence check');
    expect(prompt).toContain('Execute real side effects only when authorized and required');
    expect(prompt).toContain('when it satisfies the step without external actions');
    expect(prompt).toContain('Your step is not complete until you call the direct `plan_result` tool');
    expect(prompt).not.toContain('you MUST call tools');
    expect(prompt).not.toContain('Do NOT simulate, mock, skip tools');
    for (const resultContractVersion of [undefined, 1, 3]) {
      expect(harness().buildWorkflowStepPrompt({ ...params, resultContractVersion }))
        .toContain('you MUST call tools');
    }
  });

  it('does not let the v2 contract override dry-run or pre-response modes', () => {
    const h = harness();
    const dryRun = h.buildWorkflowStepPrompt({ ...params, resultContractVersion: 2, dryRun: true });
    expect(dryRun).toContain('do NOT persist CRM/data writes or send messages');
    expect(dryRun).not.toContain('EXECUTION MODE: LIVE');
    const preResponse = h.buildWorkflowStepPrompt({ ...params, resultContractVersion: 2, preResponseOnly: true });
    expect(preResponse).toContain('Only plan_result is available');
    expect(preResponse).toContain('Do not call business tools');
    expect(preResponse).not.toContain('EXECUTION MODE: LIVE');
  });

  it('preserves pre-response precedence, business-tool prohibition and terminal protocol', () => {
    const prompt = harness().buildWorkflowStepPrompt({ ...params, dryRun: true, preResponseOnly: true });
    expect(prompt).toContain('EXECUTION MODE: CHANNEL PRE-RESPONSE (read-only)');
    expect(prompt).toContain('Only plan_result is available');
    expect(prompt).toContain('Do NOT send or persist anything');
    expect(prompt).toContain('Do not call business tools');
    expect(prompt).toContain('MANDATORY TERMINAL PROTOCOL');
    expect(prompt).not.toContain('Suggested MCP actions');
    expect(prompt).not.toContain('EXECUTION MODE: LIVE');
    expect(prompt).not.toContain('EXECUTION MODE: DRY RUN');
  });

  it('retains sandbox, browser and credential-name/domain constraints when explicitly provided', () => {
    const prompt = harness().buildWorkflowStepPrompt({ ...params,
      step: { ...params.step, requires_sandbox: true, browser_allowed_domains: ['example.invalid'] },
      sandboxTools: [{ name: 'sandbox_browser' }], browserReady: true,
      sandboxEnvironmentKeys: ['LOCAL_WORKFLOW_CREDENTIAL'],
    });
    expect(prompt).toContain('requires_sandbox=true');
    expect(prompt).toContain('Available sandbox tools for this step:\n- sandbox_browser');
    expect(prompt).toContain('Use sandbox_browser directly; do not install agent-browser or Chrome');
    expect(prompt).toContain('Available credential names: LOCAL_WORKFLOW_CREDENTIAL');
    expect(prompt).toContain('Values are not present in process.env');
    expect(prompt).toContain('Use value_env only on trusted domains: example.invalid');
  });
});