import { ProcessorInitializer } from '../services/AgentInitializer';
import { CommandService } from '../services/CommandService';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { DbCommand } from '../models/types';
import sinon from 'sinon';

describe('AgentPrompt Integration Tests', () => {
  let processorInitializer: ProcessorInitializer;
  let commandService: CommandService;
  
  beforeEach(() => {
    // Get singleton instance
    processorInitializer = ProcessorInitializer.getInstance();
    commandService = processorInitializer.getCommandService();
    
    // Stub the DatabaseAdapter methods we'll need
    sinon.stub(DatabaseAdapter, 'isValidUUID').returns(true);
    sinon.stub(DatabaseAdapter, 'getAgentById').resolves({
      id: 'test-agent-id',
      name: 'Test Agent',
      configuration: {
        capabilities: ['test', 'prompt_testing'],
        description: 'An agent for testing prompts',
        prompt: 'This is a specific agent prompt that should be included in Agent Custom Instructions section'
      }
    });
    sinon.stub(DatabaseAdapter, 'getAgentFiles').resolves([]);
    sinon.stub(DatabaseAdapter, 'updateCommand').resolves({});
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  it('should correctly include agent prompt in agent_background when processing command', async () => {
    // Stub the command service methods
    const updateCommandStub = sinon.stub(commandService, 'updateCommand').resolves({});
    
    // Create a spy on the private method generateAgentBackground to capture its output
    const generateAgentBackgroundSpy = sinon.spy(processorInitializer as any, 'generateAgentBackground');
    
    // Set up an event handler to capture the command before processing
    const commandBeforeProcessing: DbCommand = {
      id: 'test-command-id',
      task: 'test',
      status: 'created',
      agent_id: 'test-agent-id',
      targets: [{ type: 'text', content: 'Test content' }],
      metadata: { dbUuid: 'test-db-uuid' }
    };
    
    // Manually trigger the command created event with our test command
    commandService.emit('commandCreated', commandBeforeProcessing);
    
    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify that generateAgentBackground was called with the correct agent ID
    expect(generateAgentBackgroundSpy.calledWith(sinon.match.any, 'test-agent-id')).to.be.true;
    
    // Get the agent background that was generated
    const generatedBackground = generateAgentBackgroundSpy.returnValues[0];
    
    // Verify that the background contains the agent prompt in the correct section
    expect(generatedBackground).to.include('# Agent Custom Instructions');
    expect(generatedBackground).to.include('This is a specific agent prompt that should be included');
    
    // Verify the agent background was set in the command update
    expect(updateCommandStub.calledWith('test-command-id', sinon.match({ 
      agent_background: sinon.match.string 
    }))).to.be.true;
    
    // Extra check: verify the specific content is in the updated agent_background
    const updateArg = updateCommandStub.firstCall.args[1];
    expect(updateArg.agent_background).to.include('# Agent Custom Instructions');
  });
  
  it('should log the prompt that is actually sent to the LLM', async () => {
    // Create stub for the TargetProcessor executeCommand method to capture what's sent to the LLM
    const consoleLogSpy = sinon.spy(console, 'log');
    
    // Set up an event handler to capture the command before processing
    const commandBeforeProcessing: DbCommand = {
      id: 'test-command-id',
      task: 'test',
      status: 'created',
      agent_id: 'test-agent-id',
      agent_background: '# Test agent background with custom prompt',
      targets: [{ type: 'text', content: 'Test content' }],
      metadata: { dbUuid: 'test-db-uuid' }
    };
    
    // Manually trigger the command created event with our test command
    commandService.emit('commandCreated', commandBeforeProcessing);
    
    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify that the agent background was logged properly
    const logs = consoleLogSpy.getCalls().map(call => call.args[0]).join('\n');
    
    expect(logs).to.include('agent_background');
    expect(logs).to.include('# Test agent background with custom prompt');
  });
}); 