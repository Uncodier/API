import { initializeAgentCommand } from '@/lib/agentbase/services/command/initialize-agent';
import { prepareMessagesForTarget } from '@/lib/agentbase/agents/targetEvaluator/formatters/target-message-formatter';
import { WRAP_UP_SCOPED_BACKGROUND } from '@/lib/prompts/dailyStandupWrapUpContext';

jest.mock('@/lib/agentbase/adapters/DatabaseAdapter', () => ({ DatabaseAdapter: {
  updateCommand: jest.fn(() => { throw new Error('Unexpected database call'); }),
} }));
jest.mock('@/lib/agentbase/services/command/recoverMissingAgent', () => ({
  recoverMissingAgent: jest.fn(() => { throw new Error('Unexpected agent lookup'); }),
}));
jest.mock('@/lib/agentbase/services/command/CommandCache', () => ({ CommandCache: { setAgentBackground: jest.fn() } }));

test('actual command initialization skips generic enrichment and final target messages stay scoped', async () => {
  const generateEnhancedAgentBackground = jest.fn(async () => 'DISABLED_BUSINESS_DATA');
  const command = { id: 'command', task: 'daily standup executive summary', status: 'pending',
    agent_background: WRAP_UP_SCOPED_BACKGROUND, context: 'Selected report sections: tasks\nOne task.',
  } as any;
  const initialized = await initializeAgentCommand(command, {
    processors: {}, generateEnhancedAgentBackground, updateCommand: jest.fn(),
  });
  expect(initialized).toBe(command);
  expect(generateEnhancedAgentBackground).not.toHaveBeenCalled();
  const messages = prepareMessagesForTarget(initialized, 'Produce the requested JSON target.');
  expect(messages[0].content).toContain(WRAP_UP_SCOPED_BACKGROUND);
  expect(messages[1].content).toContain('One task.');
  expect(JSON.stringify(messages)).not.toContain('DISABLED_BUSINESS_DATA');
});