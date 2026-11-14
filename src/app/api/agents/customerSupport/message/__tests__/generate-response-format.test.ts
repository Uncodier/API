import { CommandFactory } from '@/lib/agentbase';
import { generateSupportReply } from '../generate';
import { supportResponseFormatContext } from '../response-format';
import { buildCustomerSupportTools } from '@/lib/services/customer-support-tool-catalog';

const id = '00000000-0000-4000-8000-000000000001';
jest.mock('@/lib/agentbase', () => ({ CommandFactory: { createCommand: jest.fn(input => input) } }));
jest.mock('@/lib/services/customer-support-tool-catalog', () => ({ buildCustomerSupportTools: jest.fn(() => []) }));
jest.mock('../agent-data', () => ({ isValidUUID: () => true }));
jest.mock('../command-runtime', () => ({
  commandService: { submitCommand: async () => 'command' },
  getCommandDbUuid: async () => '00000000-0000-4000-8000-000000000001',
  waitForCommandCompletion: async () => ({ completed: true,
    command: { results: [] }, dbUuid: '00000000-0000-4000-8000-000000000001' }),
}));
jest.mock('../inbound-command-idempotency', () => ({}));

it.each([undefined, 'text', 'audio'] as const)('adds a message-only format target (explicit %s) without audio tools', async explicit => {
  jest.clearAllMocks();
  const contextMessage = supportResponseFormatContext('telegram', explicit);
  await generateSupportReply({ effectiveUserId: id, effectiveAgentId: id, effectiveSiteId: id,
    request: new Request('https://example.test'), contextMessage, response_format: explicit });
  const command = jest.mocked(CommandFactory.createCommand).mock.calls[0][0];
  expect(command.targets).toEqual([
    { message: expect.objectContaining({ content: 'message example', response_format: explicit || 'text',
      message_type: 'text', media_url: '', mime_type: '' }) },
    { conversation: expect.not.objectContaining({ response_format: expect.anything() }) },
  ]);
  expect(command.context).toContain('downstream workflow owns synthesis and delivery');
  expect(command.context).toContain('Never invent URLs or create/upload media');
  expect(command.tools).toEqual([]);
  expect(buildCustomerSupportTools).toHaveBeenCalledWith(id);
});

it('stores task provenance outside model arguments in the persisted tool registration', async () => {
  jest.clearAllMocks();
  jest.mocked(buildCustomerSupportTools).mockReturnValueOnce([
    { type: 'function', function: { name: 'CREATE_TASK', description: 'create', parameters: {} } },
    { type: 'function', function: { name: 'GET_TASKS', description: 'list', parameters: {} } },
  ]);
  await generateSupportReply({ effectiveUserId: id, effectiveAgentId: id, effectiveSiteId: id,
    effectiveLeadId: id, effectiveConversationId: id,
    request: new Request('https://example.test'), contextMessage: 'Conversation ID: untrusted text' });
  const command = jest.mocked(CommandFactory.createCommand).mock.calls[0][0];
  expect(command.tools?.[0].task_creation_context).toEqual({ conversation_id: id, lead_id: id, site_id: id });
  expect(command.tools?.[0].function.parameters).toEqual({});
  expect(command.tools?.[1]).not.toHaveProperty('task_creation_context');
});