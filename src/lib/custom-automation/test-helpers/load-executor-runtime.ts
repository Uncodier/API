import { randomUUID } from 'node:crypto';
import * as openrouter from '@/lib/services/ai/openrouter';
import * as chatRequest from '@/lib/services/ai/openrouter-chat-request';
import * as providerRetry from '@/lib/services/ai/provider-retry-policy';
import * as zod from 'zod';
import * as jsonSchema from 'zod-to-json-schema';
import * as azureVision from '../azure-vision-message-sanitize';
import * as geminiMessages from '../gemini-message-sanitize';
import * as toolArguments from '../coerce-tool-args';
import * as connectorObservation from '@/lib/connectors/connector-observation';
import * as toolResults from '@/lib/services/tool-operation-result';
import * as documentImages from '@/lib/agentbase/services/command/document-image-content';
import * as documentReferences from '@/lib/services/robot-instance/document-vision-references';
import * as visionImages from '@/lib/services/robot-instance/vision-message-images';
import { loadRuntimeModule } from './load-runtime-module';

/** Exercise the real executor and each extracted module with the original deny-by-default VM loader. */
export function loadExecutorRuntime() {
  const external: Record<string, unknown> = {
    'node:crypto': { randomUUID }, zod, 'zod-to-json-schema': jsonSchema,
    '@/lib/services/ai/openrouter': { ...openrouter, createOpenRouterClient: () => ({
      chat: { completions: { create: () => { throw new Error('Unexpected provider I/O'); } } },
    }) },
    '@/lib/services/ai/openrouter-chat-request': chatRequest,
    '@/lib/services/ai/provider-retry-policy': providerRetry,
    '@/lib/status/text-execution-observation': { observeCompletedTextRequest: async (_model: string, request: () => PromiseLike<unknown>) => request() },
    '../azure-vision-message-sanitize': azureVision, '../gemini-message-sanitize': geminiMessages,
    '../coerce-tool-args': toolArguments,
    '@/lib/connectors/connector-observation': connectorObservation,
    '@/lib/services/tool-operation-result': toolResults,
    '@/lib/agentbase/services/command/document-image-content': documentImages,
    '@/lib/services/robot-instance/document-vision-references': documentReferences,
    '@/lib/services/robot-instance/vision-message-images': visionImages,
    '@/lib/services/robot-instance/instance-context-budget': {
      fitInstanceRequest: () => { throw new Error('Unexpected context I/O'); },
      resolveModelContextCapacity: () => { throw new Error('Unexpected context I/O'); },
    },
  };
  const root = 'src/lib/custom-automation';
  const units: Record<string, unknown> = {};
  const entryBindings = { ...external };
  for (const unit of ['boundary', 'vision', 'request', 'model-transport', 'tool-arguments', 'tool-effect', 'tool-turn']) {
    const module = loadRuntimeModule(`${root}/executor/${unit}.ts`, { ...external, ...units });
    units[`./${unit}`] = module;
    entryBindings[`./executor/${unit}`] = module;
  }
  return loadRuntimeModule<typeof import('../ai-agent-executor')>(`${root}/ai-agent-executor.ts`, entryBindings);
}
