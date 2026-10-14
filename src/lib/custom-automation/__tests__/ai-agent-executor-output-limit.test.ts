import { finalNodeAssistantText } from '@/lib/services/robot-instance/assistant-node-results';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));

it('never settles a truncated assistant response node as completed', () => {
  const messages = [{ role: 'assistant', content: 'Partial report' }];
  expect(finalNodeAssistantText({ messages, steps: [{ finishReason: 'length' }] })).toBe('');
  expect(finalNodeAssistantText({ messages, steps: [{ finishReason: 'stop' }] })).toBe('Partial report');
  expect(finalNodeAssistantText({ messages })).toBe('Partial report');
});