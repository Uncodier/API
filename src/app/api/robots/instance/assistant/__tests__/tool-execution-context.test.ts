import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import ts from 'typescript';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as contextModule from '@/lib/services/tool-execution-context';
import { SILENT_CONTINUE_PROMPT } from '@/lib/services/robot-instance/assistant-respawn-policy';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';

const siteId = randomUUID();
const instanceId = randomUUID();
const nodeId = randomUUID();
const utilsPath = 'src/app/api/robots/instance/assistant/utils.ts';

// Execute the actual catalog and router with fail-closed I/O. All unrelated
// catalog factories are inert, so this never imports provider clients or .env.
function catalog(loadScreenAccess = async (_scope: unknown) => ({ isAdmin: true, blockedScreens: [] })) {
  const dependencies: Record<string, unknown> = {};
  const source = ts.createSourceFile(utilsPath, readFileSync(path.resolve(utilsPath), 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    const bindings = statement.importClause?.namedBindings;
    const exports: Record<string, unknown> = {};
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        exports[name] = () => ({ name, description: name, parameters: { type: 'object', properties: {} }, execute: jest.fn() });
      }
    }
    dependencies[specifier] = exports;
  }
  dependencies['@/lib/services/tool-execution-context'] = contextModule;
  dependencies['@/app/api/agents/tools/requirement_status/assistantProtocol'] = loadRuntimeModule(
    'src/app/api/agents/tools/requirement_status/assistantProtocol.ts', {
      '@/lib/tools/requirement-status-core': {
        createRequirementStatusCore: async () => { throw new Error('Unexpected status persistence'); },
        listRequirementStatusCore: async (args: unknown) => ({ success: true, query: args }),
      },
    });
  dependencies['./command-plan-guard'] = { assertStandaloneCommandPlan: async () => undefined };
  dependencies['@/lib/services/composio-service'] = { getComposioApiKeyForSite: async () => undefined };
  dependencies['@/lib/services/harness-diagnostics/tools'] = {
    refreshHarnessToolManifest: (tools: unknown) => tools,
    createHarnessDiagnosticTools: () => [],
  };
  dependencies['@/app/api/agents/tools/router/assistantProtocol'] = loadRuntimeModule(
    'src/app/api/agents/tools/router/assistantProtocol.ts', {
      '@/lib/services/embeddings-service': {},
      // Provenance is not authority. This suite isolates private context wiring;
      // the real screen policy is tested separately with denied/allowed actors.
      './screen-access': {
        loadToolScreenAccess: loadScreenAccess,
        canUseToolScreen: () => true, assertToolScopeArgs: () => {}, guardToolScreen: (tool: unknown) => tool,
      },
    });
  return loadRuntimeModule<typeof import('../utils')>(utilsPath, dependencies);
}

describe('assistant private execution context wiring', () => {
  it('passes the host-owned site and user into router authorization, separately from model arguments', async () => {
    const userId = randomUUID();
    const loadAccess = jest.fn(async (_scope: unknown) => ({ isAdmin: true, blockedScreens: [] }));
    const tools = catalog(loadAccess).getAssistantTools(siteId, userId, instanceId);
    await tools.find(tool => tool.name === 'tools')!.execute({ action: 'list', user_id: randomUUID() });
    expect(loadAccess).toHaveBeenCalledWith({ siteId, userId });
  });

  it('blocks competing interactive requirement execution while preserving reads and standalone plans', async () => {
    const utils = catalog(), userId = randomUUID(), actionId = randomUUID();
    const execute = jest.fn(async () => ({ success: true }));
    const names = ['update_repo', 'requirement_backlog', 'requirement_status', 'instance_plan'];
    const custom = names.map(name => ({ name, description: name, parameters: {}, execute }));
    const tools = utils.getAssistantToolDefinitions(siteId, userId, instanceId, custom,
      undefined, undefined, undefined, undefined, undefined, undefined, { siteId, userId, instanceId, actionId });
    const tool = (name: string) => tools.find(tool => tool.name === name)!;
    for (const [name, args] of [
      ['update_repo', { action: 'execute' }], ['requirement_backlog', { action: 'upsert' }],
      ['requirement_status', { action: 'create' }], ['instance_plan', { action: 'create', requirement_id: randomUUID() }],
    ] as const) {
      await expect(tool(name).execute(args)).rejects.toThrow('sole owner');
    }
    expect(execute).not.toHaveBeenCalled();
    await tool('requirement_backlog').execute({ action: 'list' });
    await tool('requirement_status').execute({ action: 'list' });
    await tool('instance_plan').execute({ action: 'create', title: 'Unrelated standalone plan' });
    expect(execute).toHaveBeenCalledTimes(3);
    const nonInteractive = utils.getAssistantToolDefinitions(siteId, userId, instanceId, custom);
    await nonInteractive.find(tool => tool.name === 'update_repo')!.execute({ action: 'execute' });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('assembles read-only requirement status help and defaults for the actual conversation catalog', async () => {
    const utils = catalog(), userId = randomUUID(), actionId = randomUUID(), requirementId = randomUUID();
    const tools = utils.getAssistantToolDefinitions(siteId, userId, instanceId, [], undefined,
      undefined, requirementId, undefined, undefined, undefined, { siteId, userId, instanceId, actionId });
    const status = tools.find(tool => tool.name === 'requirement_status')!;
    expect(status.description).not.toContain('MUST add a status');
    expect(status.parameters.properties.action.enum).toEqual(['list']);
    expect(status.parameters.properties).not.toHaveProperty('stage');
    await expect(status.execute({ requirement_id: requirementId })).resolves.toMatchObject({
      success: true, query: { requirement_id: requirementId, instance_id: undefined },
    });
    await expect(status.execute({ action: 'create', requirement_id: requirementId, stage: 'queued' })).rejects.toThrow('sole owner');
  });
  it('decorates before routing and never exposes context in schemas, args, or results', async () => {
    const utils = catalog();
    const privateContext = contextModule.buildToolExecutionContext({ site_id: siteId, intent: 'Private campaign purpose',
      source: { instance_id: instanceId, node_id: nodeId } })!;
    const execute = jest.fn(async (_args: unknown, _context?: contextModule.ToolExecutionContext) => ({ success: true }));
    const probe = { name: 'publish', description: 'Probe', parameters: { type: 'object', properties: {} }, execute };
    const original = probe.execute;
    const tools = await utils.getInstanceAssistantTools(siteId, undefined, instanceId, [probe],
      undefined, undefined, undefined, undefined, undefined, privateContext);
    const router = tools.find(tool => tool.name === 'tools')!;
    const args = { text: 'Public greeting' };
    const description = await router.execute({ action: 'describe', name: 'publish' });
    const result = await router.execute({ action: 'call', name: 'publish', args: JSON.stringify(args) });
    expect(result).toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledWith(args, privateContext);
    expect(probe.execute).toBe(original);
    for (const value of [tools, description, result, execute.mock.calls[0][0]]) {
      expect(JSON.stringify(value)).not.toContain(privateContext.intent);
      expect(JSON.stringify(value)).not.toContain('tool_execution_context');
    }
  });

  it('keeps old callers unchanged and isolates context objects between executions', async () => {
    const utils = catalog();
    const execute = jest.fn(async (_args: unknown, privateContext?: contextModule.ToolExecutionContext) => {
      if (privateContext) privateContext.source.tool = 'mutated';
      return { success: true };
    });
    const probe = { name: 'probe', description: 'Probe', parameters: {}, execute };
    const legacy = utils.getAssistantToolDefinitions(siteId, undefined, instanceId, [probe]);
    await legacy.find(tool => tool.name === 'probe')!.execute({});
    expect(execute).toHaveBeenLastCalledWith({});
    const privateContext = contextModule.buildToolExecutionContext({ site_id: siteId, source: {} })!;
    const tools = utils.getAssistantTools(siteId, undefined, instanceId, [probe],
      undefined, undefined, undefined, undefined, undefined, privateContext);
    const router = tools.find(tool => tool.name === 'tools')!;
    await router.execute({ action: 'call', name: 'probe', args: '{}' });
    await router.execute({ action: 'call', name: 'probe', args: '{}' });
    expect(execute.mock.calls[1][1]).not.toBe(execute.mock.calls[2][1]);
    expect(privateContext.source).toEqual({});
  });

  function turn(creditExhausted = false) {
    const getTools = jest.fn(async (..._args: any[]) => []);
    const run = loadRuntimeModule<typeof import('../assistant-turn')>(
      'src/app/api/robots/instance/assistant/assistant-turn.ts', {
        '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
        './utils': { getInstanceAssistantTools: getTools },
        './publish-node-binding': { resolvePublishNodeBinding: async () => null },
        '@/lib/messaging/publish-destinations': {},
        './conversation-recovery-tools': { CONVERSATION_RECOVERY_INSTRUCTION: '', getConversationRecoveryTools: () => [] },
        '@/lib/services/tool-execution-context': contextModule,
        '@/lib/services/robot-instance/assistant-respawn-policy': { SILENT_CONTINUE_PROMPT },
        '@/lib/services/robot-instance/assistant-recovery': { assertAssistantRecoveryActive: async () => undefined },
        '@/lib/services/workflow-robot/execution-tracker': {},
        '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: async () => {
          if (creditExhausted) throw Object.assign(new Error('Not enough credits'), { name: 'InsufficientCreditsError' });
          return { messages: [] };
        } },
        '@/lib/services/robot-instance/vision-message-images': {
          hydrateMessageImages: async (messages: unknown) => messages, dehydrateMessageImages: (messages: unknown) => messages,
        },
      }).processAssistantTurn;
    const context: any = { initialMessage: 'Call to confirm availability', systemPrompt: 'DO NOT COPY SYSTEM',
      toolOverrides: { private: 'DO NOT COPY OVERRIDES' }, customTools: [], instance: {}, instanceNodeId: nodeId,
      executionOptions: { site_id: siteId, instance_id: instanceId } };
    return { getTools, run, context };
  }

  it('uses initial request and selected instance/node IDs, not prompt/history/overrides', async () => {
    const { getTools, run, context } = turn();
    const secret = randomBytes(24).toString('hex');
    context.initialMessage += ` password=${secret}`;
    await run(context, [{ role: 'assistant', content: 'DO NOT COPY HISTORY' }]);
    const privateContext = getTools.mock.calls[0][9];
    expect(privateContext).toMatchObject({ site_id: siteId, intent: expect.stringContaining('Call to confirm'),
      source: { instance_id: instanceId, node_id: nodeId } });
    for (const forbidden of [secret, context.systemPrompt, context.toolOverrides.private, 'DO NOT COPY HISTORY']) {
      expect(JSON.stringify(privateContext)).not.toContain(forbidden);
    }
  });

  it('carries a credit rejection as data across the durable turn boundary', async () => {
    const { run, context } = turn(true);
    const messages = [{ role: 'user', content: 'Continue' }];
    await expect(run(context, messages)).resolves.toMatchObject({ creditExhausted: true, isDone: false, messages });
  });

  it('passes the persisted user-action identity separately from model provenance and request text', async () => {
    const { getTools, run, context } = turn();
    const actionId = randomUUID(), userId = randomUUID();
    context.instanceNodeId = undefined;
    context.executionOptions.user_id = userId;
    context.recoveryScope = { siteId, instanceId, userId, userMessageLogId: actionId };
    await run(context, []);
    expect(getTools.mock.calls[0][10]).toEqual({ siteId, instanceId, userId, actionId });
    expect(getTools.mock.calls[0][9]).not.toHaveProperty('actionId');
    delete context.recoveryScope;
    await run(context, []);
    expect(getTools.mock.calls[1][10]).toBeUndefined();
  });

  it('recovery skips sentinels and uses the most recent real user text, including multipart', async () => {
    const { getTools, run, context } = turn();
    context.initialMessage = SILENT_CONTINUE_PROMPT;
    await run(context, [
      { role: 'user', content: 'Old request' },
      { role: 'user', content: [{ type: 'text', text: 'Confirm Monday at five' },
        { type: 'image_url', image_url: { url: 'https://example.invalid/private.png' } }] },
      { role: 'tool', content: 'Wrong intent' },
      { role: 'user', content: [{ type: 'text', text: '[Reference Context from linked node parent_reference]:\nNot a user request' }] },
      { role: 'user', content: SILENT_CONTINUE_PROMPT },
    ]);
    expect(getTools.mock.calls[0][9].intent).toBe('Confirm Monday at five');
    await run(context, [{ role: 'assistant', content: 'Wrong intent' },
      { role: 'user', content: '[Reference Context from linked node parent_reference]:\nNot a user request' },
      { role: 'user', content: SILENT_CONTINUE_PROMPT }]);
    expect(getTools.mock.calls[1][9].intent).toBeUndefined();
  });
});