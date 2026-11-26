import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import * as recordGrounding from '@/lib/services/robot-instance/ask-record-grounding';
import { linkedAskRecordIds } from '@/lib/services/robot-instance/ask-record-links';
import { NextRequest, NextResponse } from 'next/server';
import { loadRuntimeModule as load } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { parseRecoveryExecution } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { assistantConnectorContext } from '../host-context';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { buildToolExecutionContext } from '@/lib/services/tool-execution-context';
import { bindDirectPromptAgentStep } from '@/app/api/robots/instance/assistant/direct-agent-step';
import * as ownerTranscript from '@/lib/services/robot-instance/owner-connector-transcript';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../account-access', () => ({ requireConnectorSiteAccess: jest.fn(async () => undefined) }));
const site = randomUUID(), actor = randomUUID(), instance = randomUUID(), agent = randomUUID(), spoof = randomUUID();
const action = randomUUID();
const base = 'src/app/api/robots/instance/assistant/';
const routing = { withAssistantRouting: (_s: unknown, _r: unknown, fn: () => unknown) => fn(),
  admitAssistantRouting: async () => ({ payer: 'platform', siteId: site }), validateAssistantInferenceAdmission: async () => true };
let admitted: any, snapshot: any, principal: any, observed: any, privateAnswerReady: boolean;
let run: (...args: any[]) => Promise<any>;

beforeEach(() => {
  admitted = snapshot = observed = undefined;
  privateAnswerReady = true;
  principal = { internal: false, userId: actor, siteId: null, userSession: true };
  jest.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
    const q: any = {};
    for (const method of ['select', 'eq', 'abortSignal', 'insert','not','contains','or']) q[method] = () => q;
    if (table === 'instance_logs') {
      q.update = (patch:unknown) => { expect(patch).toEqual({agent_id:agent}); return q; };
      q.maybeSingle = async () => ({error:null,data:{id:action,agent_id:agent}});
      return q;
    }
    q.maybeSingle = q.single = async () => ({ error: null, data: table === 'agents' ? { id: agent }
      : { id: instance, site_id: site, user_id: actor, agent_id: spoof, status: 'uninstantiated' } });
    return q;
  });
  const core = load<any>(base + 'assistant-turn-core.ts', {
    'node:crypto': { createHash }, './execution-routing': routing,
    '@/lib/services/ai/customer-routing': { withCustomerOperation: (_id: unknown, fn: () => unknown) => fn() },
    '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError: () => false },
    '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: async (messages: any, _instance: any, options: any) => {
      observed = await options.custom_tools[0].execute();
      return { isDone: true, text: 'done', messages };
    } },
    '@/lib/services/robot-instance/vision-message-images': { hydrateMessageImages: async (v: any) => v, dehydrateMessageImages: (v: any) => v },
    '@/lib/services/robot-instance/ask-record-grounding': recordGrounding,
    '@/lib/services/robot-instance/owner-connector-transcript': ownerTranscript,
    '@/lib/services/robot-instance/owner-connector-answer': {
      loadOwnerConnectorFollowup: async () => undefined, ownerConnectorAnswerAvailable: async () => privateAnswerReady,
    },
    './utils': { getInstanceAssistantTools: async (...args: any[]) => [{ name: 'connector', execute: async () => {
      try { return await assistantConnectorContext({ siteId: args[0], userId: args[1], instanceId: args[2], host: args[12], agentId: args[13], catalogUserSession: args[17] })(); }
      catch (e: any) { return { code: e.code }; }
    } }] },
    '@/lib/services/workflow-robot/execution-tracker': {},
    '@/lib/services/robot-instance/assistant-recovery': { assertAssistantRecoveryActive: async () => {},
      runAssistantRecoveryTool: (_s: any, _n: any, _a: any, fn: () => any) => fn() },
    './publish-node-binding': {}, '@/lib/messaging/publish-destinations': {},
    '@/lib/services/tool-execution-context': { buildToolExecutionContext },
    '@/lib/services/robot-instance/assistant-respawn-policy': { SILENT_CONTINUE_PROMPT: 'silent' },
    './conversation-recovery-tools': {},
    './requirement-host': { readRequirementAssistantHost: () => undefined, readAssistantStepResult: () => undefined,
      filterRequirementEnvironmentTools: (_e: any, tools: any) => tools },
    './cloud-context': { resolveAssistantFileEnvironment: async () => ({ environment: 'cloud' }) },
    '@/lib/cloud-files/tools': { createCloudFileTools: () => [] },
  });
  run = load<any>(base + 'workflow.ts', {
    workflow: {}, './assistant-turn': core, './execution-mode': {},
    '@/lib/services/robot-instance/assistant-failure-policy': { ASSISTANT_FAILURE_MESSAGE: 'failed' },
    './steps': { bindDirectPromptAgentStep, prepareAssistantContext: async (_i: any, message: any, _s: any, userId: any) => ({
      executionOptions: { site_id: site, instance_id: instance, user_id: userId }, instance: {},
      connectorAgentId: agent, systemPrompt: 'Actual selected prompt', initialMessage: message, customTools: [], expectedResultsAmount: 1,
    }) },
    './plan-steps': { getActiveInstancePlan: async () => null },
    './persist-and-fail-steps': { completeUserMessageStep: async () => {}, markAssistantFailedStep: async () => {} },
    '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError: () => false },
    '@/lib/services/robot-instance/assistant-respawn-policy': { isIncompleteTurn: () => false, SILENT_CONTINUE_PROMPT: 'silent' },
    './assistant-respawn-steps': {},
    './assistant-recovery-steps': {
      prepareRecoveryStep: async (_scope: any, execution: any, token: any) => {
        if (token) return { ok: true, snapshot };
        admitted = parseRecoveryExecution(JSON.parse(JSON.stringify(execution)));
        return { ok: true };
      }, guardRecoveryStep: async () => true, checkpointRecoveryStep: async () => true,
    },
    '@/lib/services/robot-instance/assistant-image-content': { buildAssistantUserContent: (v: any) => v },
  }).runAssistantWorkflow;
});

async function route(body: Record<string, unknown>) {
  const { POST } = load<any>(base + 'route.ts', {
    'next/server': { NextRequest, NextResponse }, zod: { z }, './execution-routing': routing,
    '@/lib/database/supabase-client': { supabaseAdmin },
    'workflow/api': { start: async (_fn: any, args: any[]) => ({ result: await run(...args) }) },
    './workflow': { runAssistantWorkflow: run },
    '@/lib/services/robot-instance/ask-record-links': { linkedAskRecordIds },
    './ask-submission': { claimAskSubmission: async () => ({ id: action, replay: false }), firstAskInstanceId: () => instance },
    './response-stream': { assistantResponseStream: (v: any) => NextResponse.json(v.result) },
    './publish-tool-overrides': {},
    './skill-selection': { assistantSkillSelectionSchema: z.object({}), approvedCommunityImport: () => null, resolveAssistantSkillSelection: async () => undefined },
    '@/lib/security/site-access': {}, '@/lib/services/site-skill-access': {},
    '@/lib/security/assistant-instance-access': { assistantInstanceAccess: async (_r:unknown, p: typeof principal, row: {id:string,site_id:string,user_id:string}) =>
      p.internal || (p === principal && row.id === instance && row.site_id === site && row.user_id === actor && p.userId === actor) ? 200 : 404 },
    './node-context-boundary': { isNodeSpecificContext: () => false },
    '@/lib/security/tool-request-principal': { resolveToolRequestPrincipal: async () => principal, canToolPrincipalAccessSite: async () => true },
    './execution-mode': { resolveAssistantRequestMode: () => 'direct' },
  });
  return POST(new NextRequest('https://example.test/api/robots/instance/assistant', {
    method: 'POST', body: JSON.stringify({ instance_id: instance, site_id: site, message: 'Read contacts', request_id: randomUUID(), ...body }),
  }));
}

test('real route -> workflow -> turn -> host resolver uses verified actor and prompt agent, ignoring body and raw instance agent', async () => {
  const response = await route({ user_id: spoof, callerSource: 'background', agent_id: spoof });
  expect(await response.json()).toMatchObject({ assistant_response: 'done' });
  expect(admitted.callerSource).toBe('interactive');
  expect(observed).toMatchObject({ userId: actor, agentId: agent, host: 'assistant', catalogUserSession: true });
});

test('internal service route cannot become interactive from body source or recoveryScope', async () => {
  principal = { internal: true, userId: null, siteId: null };
  await route({ user_id: actor, callerSource: 'interactive' });
  expect(admitted.callerSource).toBe('background');
  expect(observed).toEqual({ code: 'HOST_DISABLED' });
});

test('does not admit connector execution if the private answer destination is not installed', async () => {
  privateAnswerReady = false;
  await route({});
  expect(observed).not.toHaveProperty('catalogUserSession');
  expect(observed).toMatchObject({ userId:actor, agentId:agent });
});

test('new chat with NULL raw agent reaches connectors using actual prompt agent', async () => {
  const original = jest.mocked(supabaseAdmin.from).getMockImplementation()!;
  jest.mocked(supabaseAdmin.from).mockImplementation((table: any) => {
    const q: any = original(table);
    if (table === 'sites') q.single = async () => ({ data: { id: site, user_id: actor } });
    if (table === 'remote_instances') q.single = q.maybeSingle = async () => ({ data: {
      id: instance, site_id: site, user_id: actor, agent_id: null, status: 'uninstantiated',
    } });
    return q;
  });
  const response = await route({ instance_id: undefined });
  expect(await response.json()).toMatchObject({ assistant_response: 'done' });
  expect(observed).toMatchObject({ agentId: agent, userId: actor });
});

test.each(['background', undefined, 'interactive'])('claimed recovery owns source (%s), not new workflow options', async callerSource => {
  snapshot = { execution: parseRecoveryExecution({ customTools: [], useSdkTools: false, callerSource }),
    messages: [{ role: 'user', content: 'Original' }], respawnCount: 1 };
  await run(instance, 'Continue', site, actor, [], false, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { userMessageLogId: randomUUID(), resumeToken: 'server-claim', callerSource: callerSource === 'interactive' ? 'background' : 'interactive' });
  expect(observed).toMatchObject(callerSource === 'interactive' ? { agentId: agent, userId: actor } : { code: 'HOST_DISABLED' });
});

test('queue actor admission rejects legacy/missing/forged actors and never borrows instance owner', async () => {
  const start = jest.fn();
  const pending = load<any>('src/lib/services/robot-instance/pending-work.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin }, 'workflow/api': { start },
    '@/lib/security/tool-request-principal': { canToolPrincipalAccessSite: async () => true },
    '@/app/api/robots/instance/assistant/workflow': { runAssistantWorkflow: run },
    '@/app/api/robots/instance/assistant/user-message-log': {}, '@/app/api/robots/instance/assistant/execution-mode': {},
  });
  await expect(pending.startPendingAssistant({ id: randomUUID(), instance_id: instance, site_id: site, user_id: null }))
    .rejects.toThrow('actor admission');
  expect(start).not.toHaveBeenCalled();
});

test.each([
  { actor_verified: false, user_id: actor, access: true, starts: false },
  { actor_verified: true, user_id: spoof, access: true, starts: false },
  { actor_verified: true, user_id: actor, access: false, starts: false },
  { actor_verified: true, user_id: actor, access: true, starts: true },
])('queue -> real workflow -> turn keeps background origin: %j', async record => {
  const original = jest.mocked(supabaseAdmin.from).getMockImplementation()!;
  jest.mocked(supabaseAdmin.from).mockImplementation((table: any) => {
    if (table !== 'instance_pending_work') return original(table);
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: record }) };
    return q;
  });
  const start = jest.fn(async (_fn: any, args: any[]) => run(...args));
  const pending = load<any>('src/lib/services/robot-instance/pending-work.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin }, 'workflow/api': { start },
    '@/lib/security/tool-request-principal': { canToolPrincipalAccessSite: async () => record.access },
    '@/app/api/robots/instance/assistant/workflow': { runAssistantWorkflow: run },
    '@/app/api/robots/instance/assistant/user-message-log': {
      insertUserActionLog: async () => ({ id: randomUUID() }), withRetries: (fn: () => any) => fn(),
    },
    '@/app/api/robots/instance/assistant/execution-mode': { resolveAssistantRequestMode: () => 'direct' },
    '@/app/api/robots/instance/assistant/execution-routing': routing,
  });
  const dispatch = pending.startPendingAssistant({ id: randomUUID(), instance_id: instance, site_id: site,
    user_id: actor, message: 'Read contacts', context: { callerSource: 'interactive' } });
  if (record.starts) {
    await dispatch;
    expect(admitted.callerSource).toBe('background');
    expect(observed).toEqual({ code: 'HOST_DISABLED' });
  } else {
    await expect(dispatch).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  }
});

test('actual Growth Robot selection and prompt builder return the same pinned identity, never raw instance metadata', async () => {
  const seen: Record<string, unknown>[] = [];
  const admin = { from: (table: string) => {
    const selection: Record<string, unknown> = { table }; seen.push(selection);
    const q: any = { select: () => q, eq: (key: string, value: unknown) => { selection[key] = value; return q; },
      order: () => q, limit: async () => ({ data: [{ id: agent, user_id: actor }] }),
      single: async () => ({ data: { id: agent, name: 'Actual Growth Robot', agent_prompt: 'trusted prompt' } }) };
    return q;
  } };
  const finder = load<any>('src/lib/helpers/agent-finder.ts', { '@/lib/database/supabase-client': { supabaseAdmin: admin }, './command-utils': { isValidUUID: (v: string) => z.string().uuid().safeParse(v).success } });
  const prompt = jest.fn((id: string, name: string) => `Prompt for ${name} (${id})`);
  const utils = load<any>(base + 'utils.ts', {
    '@/lib/database/supabase-client': { supabaseAdmin: admin }, '@/lib/helpers/agent-finder': finder,
    '@/lib/services/agent-memory-tools-service': {}, './assistant-tools': {},
    '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder': { BackgroundBuilder: { buildAgentPrompt: prompt } },
    '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher': { DataFetcher: { getSiteInfo: async () => ({}), getActiveCampaigns: async () => [] } },
    '@/lib/timezone': { resolveClientTimezone: async () => 'UTC' },
  });
  const result = await utils.generateAssistantAgentIdentity(site, actor);
  expect(result).toEqual({ agentId: agent, background: `Prompt for Actual Growth Robot (${agent})` });
  expect(seen).toEqual([{ table: 'agents', site_id: site, status: 'active', role: 'Growth Robot' },
    { table: 'agents', id: agent, site_id: site, status: 'active' }]);
});