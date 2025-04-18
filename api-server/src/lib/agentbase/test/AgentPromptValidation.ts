/**
 * Manual test for agent prompt validation
 * Run this with: npx ts-node src/lib/agentbase/test/AgentPromptValidation.ts
 */

import { ProcessorInitializer } from '../services/AgentInitializer';
import { Base } from '../agents/Base';

// Mock Base agent for testing
class MockAgent implements Base {
  private id: string;
  private name: string;
  private capabilities: string[];
  public prompt: string;
  
  constructor(id: string, name: string, capabilities: string[], prompt: string) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
    this.prompt = prompt;
  }
  
  getId(): string { return this.id; }
  getName(): string { return this.name; }
  getCapabilities(): string[] { return this.capabilities; }
  
  // Empty implementation for executeCommand required by Base interface
  async executeCommand(): Promise<any> {
    return { status: 'mock' };
  }
}

// Function to run tests
async function runTests() {
  console.log('=== AGENT PROMPT VALIDATION TESTS ===\n');
  
  try {
    // Get the ProcessorInitializer instance
    const initializer = ProcessorInitializer.getInstance();
    initializer.initialize();
    
    // Create a test agent with custom prompt
    const testAgent = new MockAgent(
      'test-agent-id',
      'Test Agent', 
      ['test', 'validation'],
      'This is a custom agent prompt that should be included in the Agent Custom Instructions section'
    );
    
    // Access the private generateAgentBackground method using a type cast
    const generateAgentBackground = (initializer as any).generateAgentBackground.bind(initializer);
    
    if (!generateAgentBackground) {
      console.error('❌ ERROR: Could not access generateAgentBackground method');
      return;
    }
    
    console.log('✅ Successfully accessed generateAgentBackground method');
    
    // Generate the agent background
    console.log('\n=== GENERATING AGENT BACKGROUND ===');
    
    const agentBackground = await generateAgentBackground(testAgent);
    console.log(`✅ Agent background generated with length: ${agentBackground.length} characters`);
    
    // Validate that the agent prompt is included
    const hasCustomInstructions = agentBackground.includes('# Agent Custom Instructions');
    console.log(`✅ Contains '# Agent Custom Instructions' section: ${hasCustomInstructions}`);
    
    const hasAgentPrompt = agentBackground.includes(testAgent.prompt);
    console.log(`✅ Contains the agent prompt text: ${hasAgentPrompt}`);
    
    // Print the generated background for inspection
    console.log('\n=== GENERATED AGENT BACKGROUND ===');
    console.log(agentBackground);
    
    // Final results
    if (hasCustomInstructions && hasAgentPrompt) {
      console.log('\n✅ TEST PASSED: Agent prompt is correctly included in the background');
    } else {
      console.log('\n❌ TEST FAILED: Agent prompt was not correctly included in the background');
      
      if (!hasCustomInstructions) {
        console.log('- Missing "# Agent Custom Instructions" section');
      }
      
      if (!hasAgentPrompt) {
        console.log('- Agent prompt text not found in the background');
        
        // Find where the prompt should be
        const sections = agentBackground.split(/\n\n#+\s/);
        console.log('\nBackground sections:');
        sections.forEach((section, i) => {
          console.log(`${i+1}. ${section.substring(0, 50)}...`);
        });
      }
    }
  } catch (error) {
    console.error('❌ Test error:', error);
  }
}

// Run the tests
runTests().catch(console.error); 