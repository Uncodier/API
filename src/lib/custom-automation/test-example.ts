/**
 * Test Example for Custom Automation
 * 
 * This file shows how to test the custom OpenAI + Scrapybara implementation.
 * Run with: npx tsx src/lib/custom-automation/test-example.ts
 */

import { OpenAIAgentExecutor } from './openai-agent-executor';
import { ScrapybaraInstanceManager } from './scrapybara-instance-manager';
import { createScrapybaraTools } from './scrapybara-tools';
import { z } from 'zod';

// Response schema
const TaskResponseSchema = z.object({
  status: z.enum(['success', 'failed', 'needs_help']),
  message: z.string(),
  data: z.object({
    title: z.string().optional(),
    content: z.string().optional(),
  }).optional(),
});

/**
 * Test 1: Basic screenshot and bash commands
 */
async function testBasicCommands() {
  console.log('🧪 Test 1: Basic Commands\n');

  const manager = new ScrapybaraInstanceManager();
  const executor = new OpenAIAgentExecutor();

  try {
    // Start instance
    console.log('Starting Ubuntu instance...');
    const instance = await manager.startUbuntu({ timeoutHours: 1 });
    console.log(`✅ Instance started: ${instance.id}\n`);

    // Start browser
    console.log('Starting browser...');
    await manager.startBrowserInInstance(instance.id);
    console.log('✅ Browser started\n');

    // Create tools
    const tools = createScrapybaraTools(instance);

    // Execute simple task
    console.log('Executing task...\n');
    const result = await executor.act({
      model: 'gpt-4o-mini', // Use mini for testing
      tools,
      system: 'You are a helpful assistant that can execute bash commands and interact with the desktop.',
      prompt: 'Run the command "echo Hello from Scrapybara!" and tell me the output.',
      maxIterations: 5,
      onStep: (step) => {
        console.log(`📝 Step: ${step.text}`);
        if (step.toolCalls) {
          console.log(`🔧 Tools called: ${step.toolCalls.map(t => t.toolName).join(', ')}`);
        }
        console.log('');
      },
    });

    console.log('\n✅ Task completed!');
    console.log(`Final response: ${result.text}`);
    console.log(`Tokens used: ${result.usage.totalTokens}\n`);

    // Clean up
    console.log('Stopping instance...');
    await manager.stopInstance(instance.id);
    console.log('✅ Instance stopped\n');

    return true;
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 2: Web scraping with structured output
 */
async function testWebScraping() {
  console.log('🧪 Test 2: Web Scraping with Structured Output\n');

  const manager = new ScrapybaraInstanceManager();
  const executor = new OpenAIAgentExecutor();

  try {
    // Start instance
    console.log('Starting Ubuntu instance...');
    const instance = await manager.startUbuntu({ timeoutHours: 1 });
    console.log(`✅ Instance started: ${instance.id}\n`);

    // Start browser
    console.log('Starting browser...');
    await manager.startBrowserInInstance(instance.id);
    console.log('✅ Browser started\n');

    // Create tools
    const tools = createScrapybaraTools(instance);

    // Execute web scraping task with structured output
    console.log('Executing web scraping task...\n');
    const result = await executor.act({
      model: 'gpt-4o-mini',
      tools,
      schema: TaskResponseSchema,
      system: `You are a web scraping assistant. You can open websites and extract information.
      
When you complete the task, provide a structured response with:
- status: "success", "failed", or "needs_help"
- message: Description of what you did
- data: Object with extracted information (title and content)`,
      prompt: 'Go to example.com and extract the page title and first paragraph.',
      maxIterations: 10,
      onStep: (step) => {
        console.log(`📝 ${step.text}`);
        if (step.toolCalls) {
          for (const call of step.toolCalls) {
            console.log(`  🔧 ${call.toolName}(${JSON.stringify(call.args).slice(0, 50)}...)`);
          }
        }
        if (step.output) {
          console.log(`  📊 Structured output received:`, step.output);
        }
        console.log('');
      },
    });

    console.log('\n✅ Task completed!');
    console.log('Structured output:', JSON.stringify(result.output, null, 2));
    console.log(`Tokens used: ${result.usage.totalTokens}\n`);

    // Clean up
    console.log('Stopping instance...');
    await manager.stopInstance(instance.id);
    console.log('✅ Instance stopped\n');

    return true;
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 3: File operations
 */
async function testFileOperations() {
  console.log('🧪 Test 3: File Operations\n');

  const manager = new ScrapybaraInstanceManager();
  const executor = new OpenAIAgentExecutor();

  try {
    // Start instance
    console.log('Starting Ubuntu instance...');
    const instance = await manager.startUbuntu({ timeoutHours: 1 });
    console.log(`✅ Instance started: ${instance.id}\n`);

    // Create tools
    const tools = createScrapybaraTools(instance);

    // Execute file operation task
    console.log('Executing file operations...\n');
    const result = await executor.act({
      model: 'gpt-4o-mini',
      tools,
      system: 'You are a file management assistant. You can create, read, and modify files.',
      prompt: `Create a file at /tmp/test.txt with the content "Hello World!".
Then read it back and confirm the content.`,
      maxIterations: 10,
      onStep: (step) => {
        console.log(`📝 ${step.text}`);
        if (step.toolCalls) {
          console.log(`  🔧 ${step.toolCalls.map(t => t.toolName).join(', ')}`);
        }
        console.log('');
      },
    });

    console.log('\n✅ Task completed!');
    console.log(`Final response: ${result.text}`);
    console.log(`Steps executed: ${result.steps.length}`);
    console.log(`Tokens used: ${result.usage.totalTokens}\n`);

    // Clean up
    console.log('Stopping instance...');
    await manager.stopInstance(instance.id);
    console.log('✅ Instance stopped\n');

    return true;
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 4: Existing instance connection
 */
async function testExistingInstance() {
  console.log('🧪 Test 4: Connecting to Existing Instance\n');

  const manager = new ScrapybaraInstanceManager();

  try {
    // Start instance
    console.log('Starting Ubuntu instance...');
    const instance = await manager.startUbuntu({ timeoutHours: 1 });
    console.log(`✅ Instance started: ${instance.id}\n`);

    // Simulate reconnection
    console.log('Reconnecting to instance...');
    const reconnected = await manager.getInstance(instance.id);
    console.log(`✅ Reconnected to: ${reconnected.id}`);
    console.log(`   Status: ${reconnected.status}`);
    console.log(`   Type: ${reconnected.type}\n`);

    // Test pause/resume
    console.log('Testing pause...');
    await manager.pauseInstance(instance.id);
    console.log('✅ Instance paused\n');

    console.log('Testing resume...');
    await manager.resumeInstance(instance.id, { timeoutHours: 1 });
    console.log('✅ Instance resumed\n');

    // Clean up
    console.log('Stopping instance...');
    await manager.stopInstance(instance.id);
    console.log('✅ Instance stopped\n');

    return true;
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🚀 Starting Custom Automation Tests\n');
  console.log('═'.repeat(50));
  console.log('\n');

  const tests = [
    { name: 'Basic Commands', fn: testBasicCommands },
    { name: 'Web Scraping', fn: testWebScraping },
    { name: 'File Operations', fn: testFileOperations },
    { name: 'Existing Instance', fn: testExistingInstance },
  ];

  const results = [];

  for (const test of tests) {
    console.log('═'.repeat(50));
    const success = await test.fn();
    results.push({ name: test.name, success });
    console.log('═'.repeat(50));
    console.log('\n');
  }

  // Summary
  console.log('📊 Test Summary');
  console.log('═'.repeat(50));
  for (const result of results) {
    const icon = result.success ? '✅' : '❌';
    console.log(`${icon} ${result.name}`);
  }
  console.log('═'.repeat(50));

  const passed = results.filter(r => r.success).length;
  const total = results.length;
  console.log(`\n${passed}/${total} tests passed\n`);

  process.exit(passed === total ? 0 : 1);
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

export { 
  testBasicCommands, 
  testWebScraping, 
  testFileOperations, 
  testExistingInstance,
  runAllTests 
};

