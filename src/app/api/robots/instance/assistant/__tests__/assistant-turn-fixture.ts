import { createHash, randomUUID } from 'node:crypto';
import { withCustomerOperation } from '@/lib/services/ai/customer-routing';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import * as contextModule from '@/lib/services/tool-execution-context';
import { SILENT_CONTINUE_PROMPT } from '@/lib/services/robot-instance/assistant-respawn-policy';
import { RecoveryError } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import { readAssistantStepResult } from '../requirement-host';
import { createAssistantWorkspaceTools } from '../workspace-tools';
import { withAssistantRouting } from '../execution-routing';
import * as ownerTranscript from '@/lib/services/robot-instance/owner-connector-transcript';
export const siteId = randomUUID(), instanceId = randomUUID(), nodeId = randomUUID();

export function turn(creditExhausted = false, failure?: Error) {
  const getTools = jest.fn<Promise<any[]>, any[]>(async (..._args: any[]) => []);
  const executor = jest.fn(async (_messages: any, _instance: any, _options: any): Promise<any> => {
    if (failure) throw failure;
    if (creditExhausted) throw Object.assign(new Error('Not enough credits'), { name: 'InsufficientCreditsError' });
    return { messages: [] };
  });
  const ownerAnswers = {confirmOwnerConnectorContext:jest.fn(async (_claims: string[]) => undefined),
    ownerConnectorAnswerAvailable:jest.fn(async () => true),
    loadOwnerConnectorFollowup:jest.fn(async (_scope:unknown): Promise<undefined | {source_id:string,answer:string,connector_ids:string[],tool_context:{claim_id:string,result:unknown}[]} | {unavailable:true}> => undefined),
    privateContextUnavailable:() => {throw new RecoveryError('inactive');},
    publishOwnerConnectorAnswer:jest.fn(async (_scope:unknown,_claims:string[],_text:string) => 'Open your owner answer')};
  const run = loadRuntimeModule<typeof import('../assistant-turn-core')>(
    'src/app/api/robots/instance/assistant/assistant-turn-core.ts', {
    'node:crypto': { createHash },
    '@/lib/services/ai/customer-routing': { withCustomerOperation },
      './requirement-host': { readRequirementAssistantHost: () => undefined, readAssistantStepResult },
      './execution-routing': { withAssistantRouting },
      './workspace-tools': { createAssistantWorkspaceTools },
      './deployment-tools': { createAssistantDeploymentTools: () => [] },
      './cloud-context': { resolveAssistantFileEnvironment: jest.fn(async () => ({})) },
      '@/lib/cloud-files/tools': { createCloudFileTools: jest.fn(() => []) },
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
      './utils': { getInstanceAssistantTools: getTools },
      './publish-node-binding': { resolvePublishNodeBinding: async () => null },
      '@/lib/messaging/publish-destinations': {},
      './conversation-recovery-tools': { CONVERSATION_RECOVERY_INSTRUCTION: '', getConversationRecoveryTools: () => [] },
      '@/lib/services/tool-execution-context': contextModule,
      '@/lib/services/robot-instance/owner-connector-transcript': ownerTranscript,
      '@/lib/services/robot-instance/owner-connector-answer': ownerAnswers,
      '@/lib/services/robot-instance/assistant-respawn-policy': { SILENT_CONTINUE_PROMPT },
      '@/lib/services/robot-instance/assistant-recovery': { assertAssistantRecoveryActive: async () => undefined,
        runAssistantRecoveryTool: async (_scope: unknown, _name: string, _args: unknown, execute: () => Promise<unknown>) => execute() },
      '@/lib/services/workflow-robot/execution-tracker': {},
      '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: executor },
      '@/lib/services/robot-instance/vision-message-images': {
        hydrateMessageImages: async (messages: unknown) => messages, dehydrateMessageImages: (messages: unknown) => messages,
      },
    }).processAssistantTurn;
  const context: any = { initialMessage: 'Call to confirm availability', systemPrompt: 'DO NOT COPY SYSTEM',
    toolOverrides: { private: 'DO NOT COPY OVERRIDES' }, customTools: [], instance: {}, instanceNodeId: nodeId,
    executionOptions: { site_id: siteId, instance_id: instanceId } };
  return { getTools, run, context, executor, ownerAnswers };
}
