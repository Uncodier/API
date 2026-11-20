import { executeTools } from '@/lib/agentbase/agents/toolEvaluator/executor/executeTools';
import { FunctionCallStatus } from '@/lib/agentbase/agents/toolEvaluator/types';
import { OpenAIToolSet } from 'composio-core';

jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap', () => ({ hasCustomTool: () => false, getCustomToolDefinition: jest.fn() }));
jest.mock('@/lib/agentbase/agents/toolEvaluator/executor/mcpNativeTools', () => ({ hasMcpNativeTool: () => false, resolveDottedMcpCall: () => null }));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {} }));
jest.mock('composio-core', () => ({ OpenAIToolSet: jest.fn() }));

it.each(['GMAIL_FETCH_EMAILS', 'connector:11111111-1111-4111-8111-111111111111:GMAIL_FETCH_EMAILS', 'unknown_native_tool'])(
  'never sends unknown legacy tool %s to a default Composio account', async name => {
    const result = await executeTools([{ id: 'call', type: 'function', status: FunctionCallStatus.INITIALIZED, name, arguments: '{}' }], {}, { site_id: 'site', command_id: 'command' });
    expect(result[0]).toMatchObject({ status: 'error', error: expect.stringContaining('authorized connector tools router') });
    expect(OpenAIToolSet).not.toHaveBeenCalled();
  },
);