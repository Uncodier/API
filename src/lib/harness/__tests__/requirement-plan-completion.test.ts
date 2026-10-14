import { randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '../memory-store';
import { createSession, sessionRequestSchema } from '../session';
import { runSessionSlice } from '../engine';
import { createRequirementTools } from '../requirement-tools';
import type { HarnessModel, Workspace } from '../types';

it('real engine and tools recover invalid input, report a no-op, explicitly close the plan and finish without gates', async () => {
  const siteId = randomUUID(), userId = randomUUID(), requirementId = randomUUID(), instanceId = randomUUID(), planId = randomUUID();
  const session = createSession(sessionRequestSchema.parse({ objective: 'Complete the existing plan honestly',
    repository: { url: 'https://repo.example.invalid/project.git' }, limits: { maxTotalTokens: 1000000 } }));
  const run = { siteId, userId, requirementId, instanceId, sessionId: session.id, runId: 'offline-owner', executionGeneration: 1 };
  const requirement = { id: requirementId, site_id: siteId, user_id: userId, runner_instance_id: instanceId, backlog_revision: 1,
    backlog: { items: [{ id: 'first', status: 'done' }, { id: 'second', status: 'done' }] } };
  const plan = { id: planId, site_id: siteId, instance_id: instanceId, requirement_id: requirementId, status: 'pending',
    steps: [{ id: 'first-step', status: 'completed', metadata: { backlog_item_id: 'first' } },
      { id: 'second-step', status: 'completed', metadata: { backlog_item_id: 'second' } }] };
  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'assert_agent_requirement_run') return { data: true, error: null };
    const changed = args.p_step_id === null;
    if (changed) plan.status = 'completed';
    return { data: { state: changed ? 'updated' : 'unchanged', status_changed: changed, message_recorded: false,
      plan_id: planId, plan_status: plan.status, step_id: args.p_step_id, step_status: changed ? null : 'completed',
      item_id: args.p_item_id, item_status: changed ? null : 'done', backlog_revision: 1,
      plan_steps_total: 2, plan_steps_completed: 2, backlog_items_total: 2, backlog_items_completed: 2 }, error: null };
  });
  const client = { rpc, from: (table: string) => {
    const row = table === 'requirements' ? requirement : plan;
    const query: any = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: row, error: null }) };
    return query;
  } };
  const tools = createRequirementTools({ run, client });
  let modelCalls = 0;
  const model: HarnessModel = { respond: async input => {
    modelCalls++;
    expect(input.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['requirement_progress', 'requirement_context', 'finish_task']));
    const receipt = [...input.messages].reverse().find(message => message.role === 'tool');
    let name = 'requirement_progress', args: Record<string, unknown>;
    if (modelCalls === 1) args = { target: 'step', planId, status: 'completed' };
    else if (modelCalls === 2) {
      expect(JSON.parse(receipt!.content).error.message).toContain('provide planId and stepId');
      args = { target: 'step', planId, stepId: 'second-step', itemId: 'second', status: 'completed' };
    } else if (modelCalls === 3) {
      const result = JSON.parse(receipt!.content);
      expect(result.ok).toBe(true); expect(result.output.state).toBe('unchanged');
      expect(result.output.plan.status).toBe('pending');
      args = { ...result.output.availableAction.arguments, stepId: 'second-step', itemId: 'second' };
    } else {
      expect(JSON.parse(receipt!.content).output.plan.status).toBe('completed');
      name = 'finish_task'; args = { outcome: 'implemented', summary: 'Original steps and plan recorded completed; files were verified previously.' };
    }
    return { finishReason: 'tool_calls', message: { role: 'assistant', content: '', toolCalls: [{ id: `call-${modelCalls}`, name, arguments: JSON.stringify(args) }] } };
  } };
  const store = createMemorySessionStore(); await store.create(session, { siteId, userId });
  const claimed = await store.claim(session.id, siteId, 'owner', 180);
  const result = await runSessionSlice({ session: claimed!, siteId, owner: 'owner', store, tools, model,
    workspace: { ref: { provider: 'vercel', id: 'offline', root: '/vercel/sandbox' } } as Workspace });
  expect(result.status).toBe('completed'); expect(modelCalls).toBe(4); expect(plan.status).toBe('completed');
  expect(rpc.mock.calls.filter(([name]) => name === 'patch_agent_requirement_progress')).toHaveLength(2);
  expect(result.uncertainOperations).toEqual([]);
  expect(result.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).ok)).toEqual([false, true, true, true]);
});