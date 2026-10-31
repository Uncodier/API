import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as toolContext from '@/lib/services/tool-execution-context';
import * as host from '../requirement-host';

const descriptor = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} },
  execute: jest.fn(async () => ({ success: true })) });

/** Real catalog and router; every I/O dependency is explicitly inert and the loader rejects unmocked imports. */
function catalog() {
  const filename = 'src/app/api/robots/instance/assistant/utils.ts';
  const dependencies: Record<string, unknown> = {};
  const source = ts.createSourceFile(filename, readFileSync(resolve(filename), 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    const exports: Record<string, unknown> = {};
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      exports[name] = () => descriptor(name);
    }
    dependencies[(statement.moduleSpecifier as ts.StringLiteral).text] = exports;
  }
  dependencies['@/lib/services/tool-execution-context'] = toolContext;
  // Procurement contributes a catalog fragment rather than one descriptor.
  dependencies['@/lib/procurement/tools'] = { createProcurementTools: () => [] };
  dependencies['./command-plan-guard'] = { assertStandaloneCommandPlan: async () => {} };
  dependencies['@/lib/services/composio-service'] = { getComposioApiKeyForSite: async () => undefined };
  dependencies['@/lib/services/harness-diagnostics/tools'] = {
    refreshHarnessToolManifest: (tools: unknown) => tools, createHarnessDiagnosticTools: () => [],
  };
  dependencies['@/app/api/agents/tools/router/assistantProtocol'] = loadRuntimeModule(
    'src/app/api/agents/tools/router/assistantProtocol.ts', {
      '@/lib/services/embeddings-service': {},
      './screen-access': { loadToolScreenAccess: async () => ({ isAdmin: true, blockedScreens: [] }),
        canUseToolScreen: () => true, assertToolScopeArgs: () => {}, guardToolScreen: (tool: unknown) => tool },
    });
  return loadRuntimeModule<typeof import('../utils')>(filename, dependencies);
}

function fixture(environment?: 'cloud' | 'workspace') {
  const scope = { siteId: randomUUID(), instanceId: randomUUID(), userId: randomUUID() };
  const requirementId = environment ? randomUUID() : undefined;
  const workspace = ['read_files', 'exec', 'sandbox_run_command', 'deployment_create'].map(descriptor);
  const cloud = ['read_cloud_file', 'list_cloud_files', 'write_cloud_file'].map(descriptor);
  const createAssistantWorkspaceTools = jest.fn(() => workspace);
  const createCloudFileTools = jest.fn((_scope: unknown, _assertActive: () => Promise<void>) => cloud);
  const resolveAssistantFileEnvironment = jest.fn(async () => ({ environment, requirementId }));
  const assertAssistantRecoveryActive = jest.fn(async () => {});
  const executor = jest.fn(async (_messages: unknown, _instance: unknown, _options: any) => ({ messages: [] }));
  const getTools = jest.fn(catalog().getInstanceAssistantTools);
  const run = loadRuntimeModule<typeof import('../assistant-turn-core')>(
    'src/app/api/robots/instance/assistant/assistant-turn-core.ts', {
      './requirement-host': host,
      './workspace-tools': { createAssistantWorkspaceTools },
      './cloud-context': { resolveAssistantFileEnvironment },
      '@/lib/cloud-files/tools': { createCloudFileTools },
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError: () => false },
      './utils': { getInstanceAssistantTools: getTools },
      './publish-node-binding': { resolvePublishNodeBinding: async () => null },
      '@/lib/messaging/publish-destinations': {},
      './conversation-recovery-tools': { CONVERSATION_RECOVERY_INSTRUCTION: '', getConversationRecoveryTools: () => [] },
      '@/lib/services/tool-execution-context': toolContext,
      '@/lib/services/robot-instance/assistant-respawn-policy': { SILENT_CONTINUE_PROMPT: 'Offline continuation sentinel' },
      '@/lib/services/robot-instance/assistant-recovery': { assertAssistantRecoveryActive,
        runAssistantRecoveryTool: async (_scope: unknown, _name: string, _args: unknown, execute: () => Promise<unknown>) => execute() },
      '@/lib/services/workflow-robot/execution-tracker': {},
      '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: executor },
      '@/lib/services/robot-instance/vision-message-images': {
        hydrateMessageImages: async (messages: unknown) => messages, dehydrateMessageImages: (messages: unknown) => messages,
      },
    }).processAssistantTurn;
  const context: any = { initialMessage: 'Inspect the requested source', systemPrompt: 'Offline system', customTools: [], instance: {},
    executionOptions: { site_id: scope.siteId, instance_id: scope.instanceId, user_id: scope.userId, requirement_id: requirementId },
    recoveryScope: { ...scope, userMessageLogId: randomUUID() } };
  const exposedNames = async () => {
    const tools = executor.mock.calls[0][2].custom_tools;
    const router = tools.find((tool: any) => tool.name === 'tools');
    const listed = await router.execute({ action: 'list' });
    return { tools, router, names: [...tools.map((tool: any) => tool.name), ...listed.tools.map((tool: any) => tool.name)] };
  };
  return { scope, requirementId, workspace, cloud, createAssistantWorkspaceTools, createCloudFileTools,
    resolveAssistantFileEnvironment, assertAssistantRecoveryActive, getTools, executor, run, context, exposedNames };
}

test.each(['cloud', 'workspace', undefined] as const)('canonical assistant wires persisted %s environment into the real catalog before router closure capture', async environment => {
  const f = fixture(environment);
  // Even unrelated catalog/custom additions cannot reintroduce the wrong family.
  const injected = ['read_files', 'sandbox_get_or_create', 'deployment_create', 'read_cloud_file'].map(descriptor);
  f.context.customTools = injected.filter(tool => tool.name !== 'read_files');
  await f.run(f.context, []);
  expect(f.resolveAssistantFileEnvironment).toHaveBeenCalledWith({ ...f.scope, requirementId: f.requirementId });
  const { names, router } = await f.exposedNames();
  if (environment === 'cloud') {
    expect(f.createAssistantWorkspaceTools).not.toHaveBeenCalled();
    expect(f.createCloudFileTools).toHaveBeenCalledWith({ ...f.scope, requirementId: f.requirementId }, expect.any(Function));
    for (const name of ['read_files', 'exec', 'sandbox_get_or_create', 'deployment_create']) expect(names).not.toContain(name);
    for (const tool of f.cloud) expect(names).toContain(tool.name);
    const denied = await router.execute({ action: 'call', name: 'deployment_create', args: '{}' });
    expect(denied.success).toBe(false);
    expect(injected.find(tool => tool.name === 'deployment_create')!.execute).not.toHaveBeenCalled();
    expect(f.executor.mock.calls[0][2].system_prompt).toContain('not an app');
  } else if (environment === 'workspace') {
    expect(f.createCloudFileTools).not.toHaveBeenCalled();
    expect(f.createAssistantWorkspaceTools).toHaveBeenCalledTimes(1);
    for (const tool of f.cloud) expect(names).not.toContain(tool.name);
    expect(names).toContain('read_files');
    const denied = await router.execute({ action: 'call', name: 'read_cloud_file', args: '{}' });
    expect(denied.success).toBe(false);
    expect(injected.find(tool => tool.name === 'read_cloud_file')!.execute).not.toHaveBeenCalled();
  } else {
    expect(f.createCloudFileTools).toHaveBeenCalledTimes(1);
    expect(f.createAssistantWorkspaceTools).toHaveBeenCalledTimes(1);
    expect(names).toEqual(expect.arrayContaining(['read_files', 'read_cloud_file']));
    expect(f.executor.mock.calls[0][2].system_prompt).toContain('never search both by default');
  }
});

test('environment binding lookup failure stops before file factories, routing, or model inference', async () => {
  const f = fixture('cloud');
  f.resolveAssistantFileEnvironment.mockRejectedValue(new Error('Offline binding conflict'));
  await expect(f.run(f.context, [])).rejects.toThrow('binding conflict');
  expect(f.createCloudFileTools).not.toHaveBeenCalled();
  expect(f.createAssistantWorkspaceTools).not.toHaveBeenCalled();
  expect(f.getTools).not.toHaveBeenCalled();
  expect(f.executor).not.toHaveBeenCalled();
});

test('requirement host reuses its owned tools and never opens standalone cloud/workspace factories', async () => {
  const f = fixture('cloud');
  host.attachRequirementAssistantHost(f.context, { environment: 'cloud', assertActive: async () => {},
    boundary: {} as any, tools: f.cloud, refreshContext: async () => 'Owned requirement' });
  await f.run(f.context, []);
  expect(f.resolveAssistantFileEnvironment).not.toHaveBeenCalled();
  expect(f.createCloudFileTools).not.toHaveBeenCalled();
  expect(f.createAssistantWorkspaceTools).not.toHaveBeenCalled();
  expect((await f.exposedNames()).names).toEqual(expect.arrayContaining(f.cloud.map(tool => tool.name)));
});

test('standalone cloud chat retains requirement update commands but never gains owned runner tools', async () => {
  const f = fixture('cloud');
  const requirements = descriptor('requirements');
  f.context.customTools = [requirements, descriptor('sandbox_run_command'), descriptor('deployment_create')];
  await f.run(f.context, []);
  const { tools, names } = await f.exposedNames();
  expect(names).not.toContain('sandbox_run_command');
  expect(names).not.toContain('deployment_create');
  expect(names).not.toContain('requirement_progress');
  expect(names).not.toContain('requirement_plan');
  expect(f.createCloudFileTools.mock.calls[0]).toHaveLength(2); // no runner-only allowRequirementWrite capability
  const args = { action: 'update', requirement_id: f.requirementId, title: 'Updated via user command' };
  expect(await tools.find((tool: any) => tool.name === 'requirements').execute(args)).toEqual({ success: true });
  expect(requirements.execute).toHaveBeenCalledWith(args, expect.objectContaining({ site_id: f.scope.siteId }));
});

test.each(['environment', 'requirement'] as const)('standalone cloud callback rechecks %s binding before subsequent file operations', async changed => {
  const f = fixture('cloud');
  await f.run(f.context, []);
  const assertFileContext = f.createCloudFileTools.mock.calls[0][1];
  await expect(assertFileContext()).resolves.toBeUndefined();
  f.resolveAssistantFileEnvironment.mockResolvedValue(changed === 'environment'
    ? { environment: 'workspace', requirementId: f.requirementId }
    : { environment: 'cloud', requirementId: randomUUID() });
  await expect(assertFileContext()).rejects.toThrow('binding changed');
  expect(f.resolveAssistantFileEnvironment).toHaveBeenCalledTimes(3);
  expect(f.assertAssistantRecoveryActive).toHaveBeenCalled();
  for (const tool of f.cloud) expect(tool.execute).not.toHaveBeenCalled();
});