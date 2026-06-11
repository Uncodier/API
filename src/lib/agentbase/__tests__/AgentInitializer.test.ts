import { ProcessorInitializer } from '../services/AgentInitializer';
import { expect } from 'chai';
import sinon from 'sinon';
import { Base } from '../agents/Base';

describe('ProcessorInitializer', () => {
  let processorInitializer: any;
  let mockProcessor: Partial<Base>;

  beforeEach(() => {
    // Get singleton instance
    processorInitializer = ProcessorInitializer.getInstance();
    
    // Create mock processor
    mockProcessor = {
      getId: () => 'test-processor',
      getName: () => 'Test Processor',
      getCapabilities: () => ['test', 'mock'],
      description: 'A test processor for unit tests',
      prompt: 'This is a custom agent prompt that should be included in a specific section'
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('buildAgentPrompt', () => {
    it('should correctly include agentPrompt in the final prompt', () => {
      // Access the private method using any cast
      const buildAgentPrompt = (processorInitializer as any).buildAgentPrompt.bind(processorInitializer);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        'This is the backstory',
        'This is the agent prompt content'
      );
      
      // Verify that agent prompt is included in the result
      expect(result).to.include('# Agent Custom Instructions');
      expect(result).to.include('This is the agent prompt content');
      
      // Verify section order - agent prompt should come before backstory
      const promptIndex = result.indexOf('# Agent Custom Instructions');
      const backstoryIndex = result.indexOf('# Backstory');
      
      expect(promptIndex).to.be.greaterThan(0);
      expect(backstoryIndex).to.be.greaterThan(0);
      expect(promptIndex).to.be.lessThan(backstoryIndex);
      
      console.log('Generated prompt structure for testing:');
      console.log(result);
    });
    
    it('should correctly generate prompt when only backstory is provided', () => {
      const buildAgentPrompt = (processorInitializer as any).buildAgentPrompt.bind(processorInitializer);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        'This is the backstory',
        undefined
      );
      
      // Verify that backstory is included correctly
      expect(result).to.include('# Backstory');
      expect(result).to.include('This is the backstory');
      
      // Agent prompt section should not be included
      expect(result).to.not.include('# Agent Custom Instructions');
    });
    
    it('should correctly generate prompt when only agentPrompt is provided', () => {
      const buildAgentPrompt = (processorInitializer as any).buildAgentPrompt.bind(processorInitializer);
      
      const result = buildAgentPrompt(
        'test-id',
        'Test Agent',
        'A test agent description',
        ['capability1', 'capability2'],
        undefined,
        'This is the agent prompt content'
      );
      
      // Verify that agent prompt is included correctly
      expect(result).to.include('# Agent Custom Instructions');
      expect(result).to.include('This is the agent prompt content');
      
      // Backstory section should not be included
      expect(result).to.not.include('# Backstory');
    });
  });

  describe('generateAgentBackground', () => {
    it('should correctly extract and use agentPrompt from processor', async () => {
      // Create a spy on buildAgentPrompt to verify its arguments
      const buildAgentPromptSpy = sinon.spy(processorInitializer, 'buildAgentPrompt');
      
      // Access the private method using any cast
      const generateAgentBackground = (processorInitializer as any).generateAgentBackground.bind(processorInitializer);
      
      // Call the method with our mock processor
      await generateAgentBackground(mockProcessor);
      
      // Verify that buildAgentPrompt was called with the correct prompt from the processor
      expect(buildAgentPromptSpy.calledOnce).to.be.true;
      
      // Check that the agentPrompt parameter was passed correctly
      const args = buildAgentPromptSpy.getCall(0).args;
      expect(args[5]).to.equal('This is a custom agent prompt that should be included in a specific section');
    });
  });
}); 