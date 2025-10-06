/**
 * Azure OpenAI-based Agent Executor
 * 
 * This module provides a custom implementation of agent execution using Azure OpenAI's API directly,
 * replacing Scrapybara's act() method. It manages tool execution, streaming, and structured outputs.
 * 
 * CRITICAL: OpenAI Image Handling Pattern
 * ========================================
 * OpenAI does NOT allow images in 'tool' role messages.
 * Images can ONLY appear in 'user' role messages.
 * 
 * Solution implemented:
 * 1. Extract base64 images from tool results
 * 2. Add 'tool' message with text result (no image)
 * 3. Immediately add 'user' message with the image
 * 
 * This replicates how Scrapybara's backend handles OpenAI models.
 * 
 * @see https://learn.microsoft.com/azure/ai-services/openai/
 * @see https://platform.openai.com/docs/guides/vision
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Helper function to filter base64 images in messages, keeping only the latest ones up to specified limit.
 * This prevents the context window from growing infinitely with accumulated screenshots.
 * Based on Scrapybara's implementation pattern.
 * 
 * @param messages - List of messages to filter (modifies in place)
 * @param imagesToKeep - Maximum number of images to keep
 */
function filterImages(messages: any[], imagesToKeep: number): void {
  let imagesKept = 0;
  
  // Iterate backwards through messages (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    
    // Check user messages with image_url content
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const contentPart = msg.content[j];
        
        if (contentPart.type === 'image_url' && contentPart.image_url) {
          if (imagesKept < imagesToKeep) {
            imagesKept++;
          } else {
            // Remove old images by splicing from array
            msg.content.splice(j, 1);
          }
        }
      }
      
      // If user message has no content left, remove the text too to clean up
      if (msg.content.length === 0) {
        messages.splice(i, 1);
      } else if (msg.content.length === 1 && msg.content[0].type === 'text' && 
                 msg.content[0].text.includes('Here are the')) {
        // If only descriptive text left without images, remove the whole message
        messages.splice(i, 1);
      }
    }
  }
}

// Types
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: any;
  isError: boolean;
  base64Image?: string | null; // Extracted base64 image for logging/display
  cleanedResult?: any; // Cleaned result without base64 data (for API calls)
}

export interface Step {
  text: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  output?: any;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface Tool {
  name: string;
  description?: string; // Made optional to be compatible with Scrapybara SDK tools
  parameters?: Record<string, any> | z.ZodType<any>; // Can be JSON Schema or Zod schema (Scrapybara SDK)
  execute: (args: any) => Promise<any>; // Changed to 'any' to be compatible with Scrapybara SDK typed tools
}

export interface ActOptions {
  model?: string;
  tools: Tool[];
  system?: string;
  prompt?: string;
  messages?: Message[];
  schema?: z.ZodType<any>;
  onStep?: (step: Step) => Promise<void> | void;
  maxIterations?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high'; // For o-series models (o1, o3, GPT-5)
  verbosity?: 'low' | 'medium' | 'high'; // Output verbosity for o-series models
}

export interface ActResponse {
  messages: Message[];
  steps: Step[];
  text: string;
  output?: any;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AzureOpenAIConfig {
  apiKey?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

export class OpenAIAgentExecutor {
  private client: OpenAI;
  private deployment: string;

  constructor(config?: AzureOpenAIConfig | string) {
    // Support both string (legacy) and config object
    if (typeof config === 'string') {
      config = { apiKey: config };
    }

    const apiKey = config?.apiKey || process.env.MICROSOFT_AZURE_OPENAI_API_KEY;
    const endpoint = config?.endpoint || process.env.MICROSOFT_AZURE_OPENAI_ENDPOINT;
    const deployment = config?.deployment || process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    const apiVersion = config?.apiVersion || process.env.MICROSOFT_AZURE_OPENAI_API_VERSION || '2024-08-01-preview';

    if (!endpoint) {
      throw new Error('Azure OpenAI endpoint is required. Set MICROSOFT_AZURE_OPENAI_ENDPOINT environment variable.');
    }

    if (!apiKey) {
      throw new Error('Azure OpenAI API key is required. Set MICROSOFT_AZURE_OPENAI_API_KEY environment variable.');
    }

    // Configure OpenAI client for Azure
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: `${endpoint}/openai/deployments/${deployment}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': apiKey },
    });

    this.deployment = deployment;
  }

  /**
   * Extract and strip base64 images from tool results
   * Images will be sent separately as user messages (OpenAI requirement)
   */
  private extractBase64Image(result: any): { cleanedResult: any; base64Image: string | null } {
    let base64Image: string | null = null;

    if (typeof result === 'string') {
      // Check if it's a base64 image string
      if (result.includes('base64') || result.length > 10000) {
        const imageData = result.startsWith('data:image') ? result : `data:image/png;base64,${result}`;
        return {
          cleanedResult: 'Screenshot captured successfully.',
          base64Image: imageData
        };
      }
      return { cleanedResult: result, base64Image: null };
    }

    if (typeof result === 'object' && result !== null) {
      const cleaned: any = Array.isArray(result) ? [] : {};
      
      for (const [key, value] of Object.entries(result)) {
        // Detect base64 image fields
        if (key === 'base64_image' || key === 'base64Image' || key === 'screenshot' || key === 'image') {
          if (typeof value === 'string' && value.length > 1000) {
            base64Image = value.startsWith('data:image') ? value : `data:image/png;base64,${value}`;
            cleaned[key] = '[Image captured - will be shown separately]';
          } else {
            cleaned[key] = value;
          }
        } else if (typeof value === 'string' && (value.startsWith('data:image') || value.startsWith('/9j/') || value.length > 10000)) {
          // Detect base64 strings by data URI or length
          base64Image = value.startsWith('data:image') ? value : `data:image/png;base64,${value}`;
          cleaned[key] = '[Image captured - will be shown separately]';
        } else if (typeof value === 'object' && value !== null) {
          // Recursively process nested objects
          const nested = this.extractBase64Image(value);
          cleaned[key] = nested.cleanedResult;
          if (nested.base64Image && !base64Image) {
            base64Image = nested.base64Image;
          }
        } else {
          cleaned[key] = value;
        }
      }
      
      return { cleanedResult: cleaned, base64Image };
    }

    return { cleanedResult: result, base64Image: null };
  }

  /**
   * Main execution method that mimics Scrapybara's act() functionality
   */
  async act(options: ActOptions): Promise<ActResponse> {
    const {
      model, // If not provided, will use deployment from constructor
      tools,
      system,
      prompt,
      messages: initialMessages,
      schema,
      onStep,
      maxIterations = 50,
      temperature = 1, // Changed from 0.7 to 1 (Azure OpenAI default)
      reasoningEffort = 'low', // Default to low for o-series models
      verbosity = 'low', // Default to low for concise responses
    } = options;

    // Use provided model or fall back to deployment
    const deploymentName = model || this.deployment;

    // Log tools information for debugging
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Initializing with ${tools.length} tool(s):`);
    tools.forEach((tool, index) => {
      console.log(`  ${index + 1}. ${tool.name} - ${tool.description || 'No description'}`);
      if (tool.parameters) {
        const isZodSchema = typeof tool.parameters === 'object' && '_def' in tool.parameters;
        console.log(`     Parameters: ${isZodSchema ? 'Zod Schema' : 'JSON Schema'}`);
      }
    });

    // Initialize messages
    const messages: Message[] = [];
    
    if (system) {
      messages.push({ role: 'system', content: system });
    }

    if (initialMessages) {
      messages.push(...initialMessages);
    } else if (prompt) {
      messages.push({ role: 'user', content: prompt });
    }

    // Convert tools to OpenAI format
    const openaiTools = tools.map(tool => {
      let parameters: Record<string, any>;
      
      // Check if parameters is a Zod schema (from Scrapybara SDK)
      if (tool.parameters && typeof tool.parameters === 'object' && '_def' in tool.parameters) {
        // It's a Zod schema, convert to JSON Schema
        parameters = zodToJsonSchema(tool.parameters as z.ZodType<any>, {
          target: 'openApi3',
          $refStrategy: 'none',
        }) as Record<string, any>;
      } else {
        // It's already a JSON Schema or undefined
        parameters = tool.parameters as Record<string, any> || { type: 'object', properties: {} };
      }
      
      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          parameters,
        },
      };
    });

    // Track execution state
    const steps: Step[] = [];
    let totalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let iterations = 0;
    let finalText = '';
    let finalOutput: any = undefined;
    
    // Track screenshots to detect when browser is not responding to actions
    let lastScreenshotHash: string | null = null;
    let consecutiveIdenticalScreenshots = 0;

    // CRITICAL: Persistent screenshot buffer to maintain visual context across iterations
    // GPT-5 (o-series) can handle multiple images, so we keep last N screenshots for context
    const MAX_SCREENSHOT_HISTORY = 5;
    const screenshotHistory: string[] = [];

    // Main execution loop
    const MAX_ITERATIONS_WITHOUT_OUTPUT = 30; // Safety limit
    let iterationsWithoutOutput = 0;
    
    while (iterations < maxIterations) {
      iterations++;
      
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Iteration ${iterations}/${maxIterations}`);
      
      // Safety check: if schema is provided but we haven't received output after many iterations, stop
      if (schema && iterationsWithoutOutput > MAX_ITERATIONS_WITHOUT_OUTPUT) {
        console.error(`⚠️ [EXECUTOR] Safety limit reached: ${iterationsWithoutOutput} iterations without structured output. Stopping.`);
        break;
      }

      try {
        const iterationStartTime = Date.now();
        console.log(`\n⏱️ ========== ITERATION ${iterations} TIMING BREAKDOWN ==========`);
        
        // CRITICAL: Filter old images from message history to prevent infinite context growth
        // Keep only the last MAX_SCREENSHOT_HISTORY images (matching our screenshot buffer)
        const imagesBefore = messages.filter((m: any) => 
          m.role === 'user' && Array.isArray(m.content) && 
          m.content.some((c: any) => c.type === 'image_url')
        ).length;
        
        filterImages(messages, MAX_SCREENSHOT_HISTORY);
        
        const imagesAfter = messages.filter((m: any) => 
          m.role === 'user' && Array.isArray(m.content) && 
          m.content.some((c: any) => c.type === 'image_url')
        ).length;
        
        if (imagesBefore > imagesAfter) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [IMAGE_FILTER] Cleaned ${imagesBefore - imagesAfter} old image(s), kept ${imagesAfter} most recent`);
        }
        
        // Prepare completion options
        const completionOptions: any = {
          model: deploymentName, // This is the deployment name in Azure
          messages,
        };
        
        // CRITICAL: Azure OpenAI cannot return structured JSON + tool calls at the same time
        // After sufficient iterations, remove tools to force JSON response
        // Increased to 15 to give model more time to complete objectives
        const shouldForceJson = schema && iterations > 15;
        
        if (!shouldForceJson) {
          completionOptions.tools = openaiTools;
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Including tools in API call`);
        } else {
          console.log(`⚠️ [EXECUTOR] Forcing JSON output - removing tools (iteration ${iterations})`);
        }
        
        // Only include temperature if it's not the default (1)
        // Azure OpenAI rejects non-default temperature values for some models
        // NOTE: o-series models (o1, o3) don't support temperature parameter
        const isReasoningModel = deploymentName.includes('o1') || deploymentName.includes('o3') || deploymentName.includes('gpt-5');
        
        if (!isReasoningModel && temperature !== 1) {
          completionOptions.temperature = temperature;
        }
        
        // Add reasoning_effort and verbosity for o-series models (GPT-5 family: o1, o3, etc.)
        if (isReasoningModel) {
          completionOptions.reasoning_effort = reasoningEffort; // Options: low, medium, high
          completionOptions.verbosity = verbosity; // Options: low, medium, high
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Using reasoning_effort=${reasoningEffort}, verbosity=${verbosity} for o-series model: ${deploymentName}`);
        }

        // Add response format for structured output if schema is provided
        if (schema) {
          // Azure OpenAI structured outputs using JSON schema
          const jsonSchema = this.zodToJsonSchema(schema);
          completionOptions.response_format = {
            type: 'json_schema',
            json_schema: {
              name: 'response',
              schema: jsonSchema,
              strict: true,
            },
          };
        }

        // Call Azure OpenAI API
        console.log(`⏱️ [TIMING] Calling Azure OpenAI API...`);
        const azureStartTime = Date.now();
        const completion = await this.client.chat.completions.create(completionOptions);
        const azureEndTime = Date.now();
        const azureDuration = azureEndTime - azureStartTime;
        console.log(`⏱️ [TIMING] Azure OpenAI response received in ${azureDuration}ms (${(azureDuration/1000).toFixed(1)}s)`);
        
        const response = completion.choices[0];
        const message = response.message;

        // Track usage
        if (completion.usage) {
          totalUsage.promptTokens += completion.usage.prompt_tokens;
          totalUsage.completionTokens += completion.usage.completion_tokens;
          totalUsage.totalTokens += completion.usage.total_tokens;
        }

        // Add assistant message to history
        messages.push(message as Message);

        // Build step
        const step: Step = {
          text: message.content || '',
          usage: {
            promptTokens: completion.usage?.prompt_tokens || 0,
            completionTokens: completion.usage?.completion_tokens || 0,
            totalTokens: completion.usage?.total_tokens || 0,
          },
        };

        finalText = message.content || '';

        // Parse structured output if schema is provided
        if (schema && message.content) {
          try {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCHEMA] Attempting to parse structured output...`);
            const parsed = JSON.parse(message.content);
            const validated = schema.parse(parsed);
            step.output = validated;
            finalOutput = validated;
            iterationsWithoutOutput = 0; // Reset counter on successful parse
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCHEMA] ✅ Structured output validated:`, validated);
          } catch (error) {
            iterationsWithoutOutput++;
            console.log(`⚠️ [SCHEMA] Iterations without output: ${iterationsWithoutOutput}/${MAX_ITERATIONS_WITHOUT_OUTPUT}`);
            console.error('❌ [SCHEMA] Failed to parse structured output:', error);
            console.error('❌ [SCHEMA] Message content:', message.content?.substring(0, 200));
          }
        } else {
          if (schema && !message.content) {
            iterationsWithoutOutput++;
            console.log(`⚠️ [SCHEMA] Schema provided but no message content received (${iterationsWithoutOutput}/${MAX_ITERATIONS_WITHOUT_OUTPUT})`);
          } else if (schema) {
            // Schema is provided but content is not structured output (probably just tool calls)
            iterationsWithoutOutput++;
          }
        }

        // Handle tool calls
        if (message.tool_calls && message.tool_calls.length > 0) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Received ${message.tool_calls.length} tool_call(s) from Azure`);
          
          let toolCalls: ToolCall[] = [];
          
          // Parse tool calls with error handling
          try {
            toolCalls = message.tool_calls.map((tc: any) => {
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_PARSE] Parsing tool call: ${tc.id} - ${tc.function.name}`);
              return {
                toolCallId: tc.id,
                toolName: tc.function.name,
                args: JSON.parse(tc.function.arguments),
              };
            });
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ Successfully parsed ${toolCalls.length} tool call(s)`);
          } catch (parseError: any) {
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ Error parsing tool calls:`, parseError);
            
            // Add error messages for all tool_calls to prevent Azure error
            for (const tc of message.tool_calls) {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.function.name,
                content: `Error parsing tool call arguments: ${parseError.message}`,
              });
            }
            
            // Skip this iteration
            continue;
          }

          step.toolCalls = toolCalls;
          
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] Executing ${toolCalls.length} tool call(s):`);
          toolCalls.forEach((tc, idx) => {
            console.log(`  ${idx + 1}. ${tc.toolName} (${tc.toolCallId}) - Args:`, JSON.stringify(tc.args).substring(0, 100));
          });

          // Execute tools
          const toolResults: ToolResult[] = [];
          const allToolsStartTime = Date.now();
          
          // CRITICAL: Collect all images FIRST, then add them as a single user message AFTER all tool messages
          // Azure OpenAI requires ALL tool messages to be together before any user messages
          const collectedImages: string[] = [];
          
          for (const toolCall of toolCalls) {
            const toolStartTime = Date.now();
            console.log(`⏱️ [TOOL_START] ${toolCall.toolName} (${toolCall.toolCallId}) - Starting execution...`);
            const tool = tools.find(t => t.name === toolCall.toolName);
            
            if (!tool) {
              const errorMsg = `Error: Tool ${toolCall.toolName} not found`;
              console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_ERROR] Tool not found: ${toolCall.toolName} (${toolCall.toolCallId})`);
              
              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: errorMsg,
                isError: true,
              });
              
              // CRITICAL: Must add tool message to messages array
              // Otherwise Azure OpenAI will reject the next API call
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: errorMsg,
              });
              
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);
              
              continue;
            }

            try {
              let result: any;
              
              // OPTIMIZATION: Execute wait actions locally instead of round-trip to Scrapybara
              if (toolCall.toolName === 'computer' && toolCall.args.action === 'wait') {
                const duration = toolCall.args.duration || 1000;
                console.log(`⚡ [WAIT_LOCAL] Executing wait locally for ${duration}ms instead of calling Scrapybara`);
                
                // Execute wait locally with a simple promise
                await new Promise(resolve => setTimeout(resolve, duration));
                
                result = `Waited for ${duration}ms`;
                console.log(`⚡ [WAIT_LOCAL] Local wait completed`);
              } else {
                // Execute tool normally via Scrapybara
                console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Calling ${toolCall.toolName}.execute() with Scrapybara SDK...`);
                result = await tool.execute(toolCall.args);
                
                // Log raw result details for debugging
                if (result === undefined || result === null) {
                  console.warn(`⚠️ [SCRAPYBARA] ${toolCall.toolName} returned ${result === undefined ? 'undefined' : 'null'}`);
                } else if (typeof result === 'object') {
                  const keys = Object.keys(result);
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Result is object with keys: [${keys.join(', ')}]`);
                  
                  // CRITICAL: Check for errors and validate action execution
                  if (result.error && result.error.length > 0) {
                    console.error(`⚠️ [SCRAPYBARA] Error field contains: "${result.error}"`);
                  }
                  
                  if (result.output && result.output.length > 0) {
                    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Output: "${result.output.substring(0, 200)}"`);
                  }
                  
                  // Check for common error fields
                  if (result.failed || result.success === false) {
                    console.error(`⚠️ [SCRAPYBARA] Result indicates failure:`, result.failed || 'success=false');
                  }
                  
                  // CRITICAL: For non-screenshot actions, empty output+error might indicate failure
                  if (toolCall.args.action !== 'take_screenshot' && 
                      (!result.output || result.output === '') && 
                      (!result.error || result.error === '')) {
                    console.warn(`⚠️ [SCRAPYBARA] ${toolCall.args.action} returned empty output and error - action may not have executed`);
                    console.warn(`⚠️ [SCRAPYBARA] This usually indicates the browser window lost focus or X11 display has input issues`);
                    console.warn(`⚠️ [SCRAPYBARA] Full result keys:`, Object.keys(result).join(', '));
                  }
                  
                  // Log system messages if present - THIS MAY CONTAIN THE REAL ERROR
                  if (result.system) {
                    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] System info:`, JSON.stringify(result.system));
                    
                    // Check if system contains error information
                    if (typeof result.system === 'object') {
                      if (result.system.error || result.system.message || result.system.status) {
                        console.error(`🚨 [SCRAPYBARA_SYSTEM] System field indicates issue:`, result.system);
                      }
                    }
                  }
                } else {
                  console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCRAPYBARA] Result type: ${typeof result}, length: ${String(result).length}`);
                }
              }
              
              const toolEndTime = Date.now();
              const toolDuration = toolEndTime - toolStartTime;
              console.log(`⏱️ [TOOL_END] ${toolCall.toolName} completed in ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s)`);
              
              // Store full result in toolResults for onStep callback
              // CRITICAL: Extract base64 images from result
              // OpenAI does NOT allow images in 'tool' messages, only in 'user' messages
              const { cleanedResult, base64Image } = this.extractBase64Image(result);
              
              if (base64Image) {
                console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_IMAGE] ${toolCall.toolName} returned base64 image (${base64Image.length} chars)`);
                
                // CRITICAL: Detect if screenshot is identical to previous one
                // This indicates the browser is not responding to actions
                const screenshotHash = base64Image.substring(0, 100); // Use first 100 chars as hash
                if (lastScreenshotHash === screenshotHash) {
                  consecutiveIdenticalScreenshots++;
                  console.warn(`⚠️ [SCREENSHOT_DUPLICATE] Screenshot #${consecutiveIdenticalScreenshots + 1} is identical to previous one - browser may not be responding to actions`);
                  
                  // Alert if we have too many identical screenshots
                  if (consecutiveIdenticalScreenshots >= 3) {
                    console.error(`🚨 [SCREENSHOT_DUPLICATE] ${consecutiveIdenticalScreenshots + 1} consecutive identical screenshots detected!`);
                    console.error(`🚨 [SCREENSHOT_DUPLICATE] Browser is likely NOT responding to computer tool actions`);
                    console.error(`🚨 [SCREENSHOT_DUPLICATE] Recent actions: ${toolCalls.map(tc => `${tc.toolName}(${tc.args.action})`).join(', ')}`);
                  }
                } else {
                  if (consecutiveIdenticalScreenshots > 0) {
                    console.log(`✅ [SCREENSHOT_CHANGED] Screenshot changed after ${consecutiveIdenticalScreenshots + 1} identical ones`);
                  }
                  consecutiveIdenticalScreenshots = 0;
                  lastScreenshotHash = screenshotHash;
                }
                
                // Collect image to add AFTER all tool messages
                collectedImages.push(base64Image);
                
                // Add to persistent screenshot history for cross-iteration context
                screenshotHistory.push(base64Image);
                // Keep only last N screenshots to manage token usage
                if (screenshotHistory.length > MAX_SCREENSHOT_HISTORY) {
                  screenshotHistory.shift(); // Remove oldest screenshot
                }
              } else {
                console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_NO_IMAGE] ${toolCall.toolName} - no image in result`);
              }
              
              // Store FULL result in toolResults for onStep callback (with image reference)
              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result, // Keep original result with image for logging
                base64Image: base64Image, // CRITICAL: Preserve extracted image for logging
                cleanedResult: cleanedResult, // Also include cleaned version
                isError: false,
              });
              
              // Add tool message with text only (NO image)
              // DO NOT add user messages here - they will be added AFTER all tool messages
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: typeof cleanedResult === 'string' ? cleanedResult : JSON.stringify(cleanedResult),
              });
              
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added tool message for ${toolCall.toolCallId}`);

            } catch (error: any) {
              const toolEndTime = Date.now();
              const toolDuration = toolEndTime - toolStartTime;
              const errorMessage = error.message || String(error);
              console.error(`⏱️ [TOOL_ERROR] ${toolCall.toolName} (${toolCall.toolCallId}) failed after ${toolDuration}ms (${(toolDuration/1000).toFixed(1)}s) - ${errorMessage.substring(0, 100)}`);
              
              toolResults.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: errorMessage,
                isError: true,
              });

              // Add error to messages
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.toolCallId,
                name: toolCall.toolName,
                content: `Error: ${errorMessage}`,
              });
              
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOL_MSG] ✅ Added error tool message for ${toolCall.toolCallId}`);
            }
          }

          const allToolsEndTime = Date.now();
          const allToolsDuration = allToolsEndTime - allToolsStartTime;
          console.log(`⏱️ [TOOLS_TOTAL] All ${toolCalls.length} tool(s) executed in ${allToolsDuration}ms (${(allToolsDuration/1000).toFixed(1)}s)`);

          // CRITICAL SAFETY CHECK: Ensure ALL tool_call_ids have corresponding tool messages
          // This prevents the "tool_call_ids did not have response messages" error from Azure
          const toolMessageIds = new Set(
            messages
              .filter((m: any) => m.role === 'tool')
              .map((m: any) => m.tool_call_id)
          );
          
          const missingToolCallIds = toolCalls.filter(tc => !toolMessageIds.has(tc.toolCallId));
          
          if (missingToolCallIds.length > 0) {
            console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ CRITICAL: ${missingToolCallIds.length} tool_call_id(s) missing tool messages!`);
            missingToolCallIds.forEach(tc => {
              console.error(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ❌ Missing: ${tc.toolCallId} (${tc.toolName})`);
              
              // Add emergency error message to prevent Azure error
              messages.push({
                role: 'tool',
                tool_call_id: tc.toolCallId,
                name: tc.toolName,
                content: `Error: Tool execution failed unexpectedly. No response recorded.`,
              });
            });
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ Added emergency tool messages for missing tool_call_ids`);
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [TOOLS] ✅ All ${toolCalls.length} tool_call_ids have corresponding tool messages`);
          }
          
          // NOW add collected images as a single user message AFTER all tool messages
          // CRITICAL: Use persistent screenshot history for better context across iterations
          // GPT-5 can handle multiple images, so we send the full history (last N screenshots)
          const shouldIncludeScreenshots = iterations <= 3 || iterations % 3 === 0;
          
          // Use screenshot history instead of just current iteration's images
          // This gives the model visual context of "where we came from"
          const screenshotsToSend = screenshotHistory.length > 0 ? screenshotHistory : collectedImages;
          
          if (screenshotsToSend.length > 0 && shouldIncludeScreenshots) {
            const isHistorical = screenshotsToSend === screenshotHistory;
            const historyNote = isHistorical ? ` (including ${screenshotHistory.length} from history for context)` : '';
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS] Adding ${screenshotsToSend.length} screenshot(s)${historyNote} as single user message in iteration ${iterations}`);
            
            // Build content array with text + all images
            const imageContent: any[] = [
              {
                type: 'text',
                text: screenshotsToSend.length === 1 
                  ? 'Here is the visual result from the previous action:' 
                  : `Here are the last ${screenshotsToSend.length} screenshots showing the progression of actions (most recent last):`
              }
            ];
            
            // Add all screenshots from history (oldest to newest)
            screenshotsToSend.forEach((image, idx) => {
              imageContent.push({
                type: 'image_url',
                image_url: {
                  url: image,
                  detail: 'low'  // Use 'low' to save tokens (85 tokens vs 765+)
                }
              });
            });
            
            messages.push({
              role: 'user',
              content: imageContent
            } as any);
            
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS] ✅ Added user message with ${screenshotsToSend.length} image(s)`);
          } else if (screenshotsToSend.length > 0) {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [SCREENSHOTS_SKIP] Skipping ${screenshotsToSend.length} screenshot(s) in iteration ${iterations} to reduce content filter risk`);
          }

          step.toolResults = toolResults;
          
          // If schema is provided and we've executed tools, add reminder to provide structured output
          // Only remind after iteration 6 and only if we're approaching the force-json threshold (iteration 10)
          if (schema && toolResults.length > 0 && iterations >= 8 && iterations % 2 === 0) {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REMINDER] Adding gentle reminder to request structured output (iteration ${iterations})`);
            messages.push({
              role: 'user',
              content: `⚠️ REMINDER: When you complete the current step objective, provide your response in JSON format with event, step, and assistant_message fields.`
            });
          }
        }

        // Add step to history
        steps.push(step);

        // Call onStep callback
        if (onStep) {
          await onStep(step);
        }

        // Check if we should stop
        const shouldStop = response.finish_reason === 'stop' || 
                          (schema && finalOutput !== undefined) ||
                          !message.tool_calls;
        
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Should stop: ${shouldStop} (finish_reason=${response.finish_reason}, hasSchema=${!!schema}, hasOutput=${finalOutput !== undefined}, hasToolCalls=${!!message.tool_calls})`);
        
        const iterationEndTime = Date.now();
        const iterationDuration = iterationEndTime - iterationStartTime;
        console.log(`⏱️ [ITERATION_TOTAL] Iteration ${iterations} completed in ${iterationDuration}ms (${(iterationDuration/1000).toFixed(1)}s)`);
        console.log(`⏱️ ========== END ITERATION ${iterations} ==========\n`);
        
        if (shouldStop) {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Breaking loop after ${iterations} iterations`);
          break;
        }
        
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR] Continuing to next iteration...`);

      } catch (error: any) {
        console.error('Error in agent execution:', error);
        
        // Handle content filter errors from Azure OpenAI
        if (error.code === 'content_filter' || error.message?.includes('content management policy')) {
          console.error('❌ [CONTENT_FILTER] Azure OpenAI blocked the response due to content policy');
          console.error('❌ [CONTENT_FILTER] This may be a false positive. Consider:');
          console.error('   1. Adjusting content filter settings in Azure Portal');
          console.error('   2. Reviewing recent screenshots for sensitive content');
          console.error('   3. Modifying the system prompt');
          
          // Return a graceful error instead of crashing
          return {
            messages,
            steps,
            text: 'Content filter triggered - execution stopped',
            output: schema ? {
              event: 'step_failed',
              step: iterations,
              assistant_message: 'Azure OpenAI content filter triggered. The response was blocked due to content policy. This may be a false positive.'
            } : undefined,
            usage: totalUsage,
          };
        }
        
        // If error contains info about missing tool responses, it means we have an inconsistent state
        // This can happen if the API call was made with tool_calls but messages don't have matching tool responses
        if (error.message && error.message.includes('tool_call_id')) {
          console.error('⚠️ Tool call mismatch detected. Messages state:', JSON.stringify(messages.slice(-5), null, 2));
        }
        
        throw error;
      }
    }

    return {
      messages,
      steps,
      text: finalText,
      output: finalOutput,
      usage: totalUsage,
    };
  }

  /**
   * Convert Zod schema to JSON Schema for OpenAI structured outputs
   */
  private zodToJsonSchema(schema: z.ZodType<any>): Record<string, any> {
    // Basic implementation - you may want to use a library like zod-to-json-schema
    // For now, we'll create a simple converter
    
    const convert = (s: any): any => {
      if (s instanceof z.ZodObject) {
        const shape = s.shape;
        const properties: Record<string, any> = {};
        const required: string[] = [];

        for (const [key, value] of Object.entries(shape)) {
          properties[key] = convert(value);
          if (!(value as any).isOptional()) {
            required.push(key);
          }
        }

        return {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        };
      }

      if (s instanceof z.ZodString) {
        return { type: 'string' };
      }

      if (s instanceof z.ZodNumber) {
        return { type: 'number' };
      }

      if (s instanceof z.ZodBoolean) {
        return { type: 'boolean' };
      }

      if (s instanceof z.ZodArray) {
        return {
          type: 'array',
          items: convert(s.element),
        };
      }

      if (s instanceof z.ZodEnum) {
        return {
          type: 'string',
          enum: s.options,
        };
      }

      if (s instanceof z.ZodOptional) {
        return convert(s.unwrap());
      }

      if (s instanceof z.ZodNullable) {
        const inner = convert(s.unwrap());
        return {
          ...inner,
          nullable: true,
        };
      }

      // Default fallback
      return { type: 'string' };
    };

    return convert(schema);
  }
}

