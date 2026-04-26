/**
 * Assistant Executor Service
 * Unified execution for OpenAI/Azure assistant without Scrapybara tools
 */

import { AIAgentExecutor, type AIProvider } from '@/lib/custom-automation/ai-agent-executor';
import { CreditService, InsufficientCreditsError } from '@/lib/services/billing/CreditService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  createAssistantOnStepHandler,
  createStreamingLogCallbacks,
  createThinkingStreamLogCallbacks,
  createNodeStreamingCallbacks,
  fetchNodeContexts,
  batchCreateResponseNodes,
  updateNodeResult,
  failNode,
} from './assistant-logging';
import { buildNodeResult, buildInitialNodeResult } from './node-result-collector';

/**
 * Extract text from a node based on what the context type asks for.
 * 'result' -> node.result.text
 * 'prompt' -> node.prompt.text or node.prompt
 * anything else -> try result first, fallback to prompt
 */
function extractNodeText(node: any, type: string): string {
  if (type === 'prompt') {
    if (!node.prompt) return '';
    if (typeof node.prompt === 'string') {
      try { return JSON.parse(node.prompt).text || node.prompt; } catch { return node.prompt; }
    }
    return node.prompt?.text || JSON.stringify(node.prompt);
  }

  // 'result' or any other type -> extract from result
  const res = node.result;
  if (!res) return '';
  if (typeof res === 'string') {
    try { return JSON.parse(res).text || res; } catch { return res; }
  }
  if (res.text) return res.text;
  const str = JSON.stringify(res);
  return str === '{}' ? '' : str;
}

/**
 * Extract image URLs from a node's result.outputs so they can be
 * injected as multimodal image_url parts in the next node's context.
 */
function extractNodeImageUrls(node: any): string[] {
  const res = node?.result;
  if (!res) return [];

  const parsed = typeof res === 'string'
    ? (() => { try { return JSON.parse(res); } catch { return null; } })()
    : res;

  if (!parsed?.outputs || !Array.isArray(parsed.outputs)) return [];

  return parsed.outputs
    .filter((o: any) => o.type === 'image' && o.data?.url)
    .map((o: any) => o.data.url as string);
}

/**
 * Build the message content for a context entry.
 * Returns a multimodal array when images are present, plain string otherwise.
 */
function buildContextContent(
  text: string,
  imageUrls: string[],
  label: string,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (imageUrls.length === 0) {
    return `[Context from node ${label}]: ${text}`;
  }

  const parts: any[] = [];
  if (text) {
    parts.push({ type: 'text', text: `[Context from node ${label}]: ${text}` });
  }
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

export interface AssistantExecutionOptions {
  use_sdk_tools?: boolean;
  /**
   * Label used for credits/logging (NOT the underlying LLM provider).
   * Kept as 'azure' | 'openai' | 'gemini' for backwards-compatibility.
   */
  provider?: 'azure' | 'openai' | 'gemini';
  system_prompt?: string;
  custom_tools?: any[];
  instance_id?: string;
  site_id?: string;
  user_id?: string;
  instance_node_id?: string;
  expected_results_amount?: number;
  /**
   * Override the LLM provider for this execution. Falls back to env AI_PROVIDER (default 'gemini').
   */
  ai_provider?: AIProvider;
  /**
   * Override the LLM model id for this execution. Falls back to env AI_MODEL / provider default.
   */
  ai_model?: string;
}

export interface AssistantExecutionResult {
  text: string;
  output: any;
  usage: any;
  steps?: any[];
}

/**
 * Prepare tools for assistant execution
 */
export async function prepareAssistantTools(
  instance: any,
  options: AssistantExecutionOptions
) {
  const {
    custom_tools = [],
  } = options;

  // Case 2: OpenAI/Azure
  return {
      type: 'openai',
      tools: custom_tools
  };
}

/**
 * Execute a single step (iteration) of the assistant
 */
export async function executeAssistantStep(
  messages: any[],
  instance: any,
  options: AssistantExecutionOptions
): Promise<AssistantExecutionResult & { messages: any[], isDone: boolean }> {
  const {
    system_prompt = 'You are a helpful AI assistant.',
    instance_id,
    site_id,
    user_id,
  } = options || {};
  
  const provider = options.provider || process.env.ROBOT_SDK_PROVIDER || 'gemini';

  if (site_id) {
    try {
      const hasCredits = await CreditService.validateCredits(site_id, 0.001); // minimal requirement to start
      if (!hasCredits) {
        throw new InsufficientCreditsError('Insufficient credits for assistant step execution');
      }
    } catch (e: any) {
      console.error('Credit validation failed in step:', e.message);
      throw e;
    }
  }

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing assistant step. Provider: ${provider}, Messages: ${messages.length}`);

  try {
      const prepared = await prepareAssistantTools(instance, options || {});

      // OpenAI / Azure / Gemini - We can step!
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ AI provider - running single iteration`);

      const executor = new AIAgentExecutor({
        provider: options.ai_provider,
        model: options.ai_model,
      });
      
      const streamingCallbacks = instance_id && site_id
          ? createStreamingLogCallbacks(instance_id, site_id, user_id, provider)
          : undefined;
      
      const thinkingStreamCallbacks = instance_id && site_id
        ? createThinkingStreamLogCallbacks(instance_id, site_id, user_id, provider)
        : undefined;

      // Instance Node handling
      const instance_node_id = options.instance_node_id;
      const expectedResults = options.expected_results_amount || 1;
      let promptNode: any = null;
      let contextEntries: Awaited<ReturnType<typeof fetchNodeContexts>> = [];

      if (instance_node_id) {
        const { data } = await supabaseAdmin
          .from('instance_nodes')
          .select('*')
          .eq('id', instance_node_id)
          .single();
        promptNode = data;

        if (promptNode) {
          contextEntries = await fetchNodeContexts(instance_node_id);

          // Prepend context nodes as messages (with multimodal image support)
          if (contextEntries.length > 0) {
            const contextMessages: any[] = [];
            for (const entry of contextEntries) {
              const text = extractNodeText(entry.node, entry.type);
              const imageUrls = extractNodeImageUrls(entry.node);

              if (text || imageUrls.length > 0) {
                contextMessages.push({
                  role: 'user',
                  content: buildContextContent(text, imageUrls, entry.type),
                });
              }
            }
            if (contextMessages.length > 0) {
              console.log(`[Node Executor] Injecting ${contextMessages.length} context messages from linked nodes`);
              messages = [...contextMessages, ...messages];
            }
          }
        }
      }

      const contextRefs = contextEntries.map(e => ({
        context_node_id: e.context_node_id,
        type: e.type,
      }));

      // When running in node mode, allow enough iterations for the LLM to
      // call tools, see results, and produce a final text — all in one shot.
      const nodeMaxIterations = instance_node_id ? 5 : 1;

      // --- MULTI-OUTPUT: N > 1 -> fan-out parallel LLM calls ---
      if (promptNode && expectedResults > 1) {
        console.log(`[Node Executor] Multi-output: creating ${expectedResults} response nodes`);

        const responseNodeIds = await batchCreateResponseNodes(
          instance_node_id!, promptNode, expectedResults, contextRefs
        );

        // Run N independent LLM calls in parallel
        const initialOutputs = buildInitialNodeResult(promptNode).outputs;
        const parallelExecutor = new AIAgentExecutor({
          provider: options.ai_provider,
          model: options.ai_model,
        });
        const parallelPromises = responseNodeIds.map(async (nodeId: string, index: number) => {
          let accumulatedText = '';
          let lastUpdate = Date.now();
          const THROTTLE_MS = 500;

          try {
            const result = await parallelExecutor.act({
              tools: prepared.tools,
              system: system_prompt,
              messages: [...messages],
              onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
              stream: true,
              onStreamStart: async () => {
                return `node-stream-${nodeId}`;
              },
              onStreamChunk: async (_logId: string, text: string) => {
                accumulatedText = text;
                const now = Date.now();
                if (now - lastUpdate > THROTTLE_MS) {
                  const chunkResult: any = { text: accumulatedText, status: 'streaming' };
                  if (initialOutputs) chunkResult.outputs = initialOutputs;
                  await updateNodeResult(nodeId, chunkResult);
                  lastUpdate = now;
                }
              },
              maxIterations: nodeMaxIterations,
            });

            const nodeResult = buildNodeResult(result.text || accumulatedText, 'done', result.steps);
            await updateNodeResult(nodeId, nodeResult);
            console.log(`[Node Executor] Response node ${index + 1}/${expectedResults} completed: ${nodeId}, outputs: ${nodeResult.outputs?.length || 0}`);
            return result;
          } catch (err: any) {
            await failNode(nodeId, err.message || 'Unknown error');
            console.error(`[Node Executor] Response node ${index + 1}/${expectedResults} failed: ${nodeId}`, err);
            return null;
          }
        });

        const results = await Promise.all(parallelPromises);
        const firstValid = results.find(r => r !== null);

        // Also run the primary instance_log streaming for the first result
        if (streamingCallbacks && firstValid) {
          const logId = await streamingCallbacks.onStreamStart();
          await streamingCallbacks.onStreamChunk(logId, firstValid.text || '');
        }

        // Return the first valid result to maintain compatibility
        var executionResult: any = firstValid || { text: '', output: null, usage: {}, steps: [], messages, isDone: true };

      // --- SINGLE OUTPUT: N = 1 -> original behavior ---
      } else {
        let nodeCallbacks: Awaited<ReturnType<typeof createNodeStreamingCallbacks>> | undefined;
        let nodeResponseId: string | null = null;

        if (promptNode) {
          nodeCallbacks = createNodeStreamingCallbacks(instance_node_id!, promptNode, contextRefs);
        }

        // Wrap streaming callbacks to also update instance_nodes
        const wrappedOnStreamStart = streamingCallbacks ? async () => {
          const logId = await streamingCallbacks.onStreamStart();
          if (nodeCallbacks) {
            try { nodeResponseId = await nodeCallbacks.onNodeStreamStart(); } catch (e) { console.error('[Node Executor] onNodeStreamStart error:', e); }
          }
          return logId;
        } : undefined;

        const wrappedOnStreamChunk = streamingCallbacks ? async (logId: string, accumulatedText: string) => {
          await streamingCallbacks.onStreamChunk(logId, accumulatedText);
          if (nodeCallbacks && nodeResponseId) {
            try { await nodeCallbacks.onNodeStreamChunk(nodeResponseId, accumulatedText); } catch (e) { /* throttle errors */ }
          }
        } : undefined;

        var executionResult = await executor.act({
                tools: prepared.tools,
                system: system_prompt,
                messages: messages,
                onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
                stream: !!streamingCallbacks,
                onStreamStart: wrappedOnStreamStart,
                onStreamChunk: wrappedOnStreamChunk,
                onThinkingStreamStart: thinkingStreamCallbacks?.onThinkingStreamStart,
                onThinkingStreamChunk: thinkingStreamCallbacks?.onThinkingStreamChunk,
                onReasoningTokensUsed: thinkingStreamCallbacks?.onReasoningTokensUsed,
                maxIterations: nodeMaxIterations,
            });

        // Finalize node — pack text + tool outputs into unified result
        if (nodeCallbacks && nodeResponseId) {
          try {
            const nodeResult = buildNodeResult(executionResult.text || '', 'done', executionResult.steps);
            await nodeCallbacks.onNodeStreamEnd(nodeResponseId, nodeResult);
          } catch (e) {
            console.error('[Node Executor] onNodeStreamEnd error:', e);
          }
        }
      }
          
          const lastMessage = executionResult.messages[executionResult.messages.length - 1];
          const hasToolCalls = lastMessage?.tool_calls && lastMessage.tool_calls.length > 0;
          
          const lastRole = lastMessage?.role;
          // Node executions are self-contained (higher maxIterations allows tool
          // completion). Force isDone so the workflow doesn't loop and create
          // duplicate response nodes.
          const isDone = instance_node_id
            ? true
            : (lastRole === 'assistant' && !hasToolCalls);
          
          const result = {
              text: executionResult.text,
              output: executionResult.output,
              usage: executionResult.usage,
              steps: executionResult.steps,
              messages: executionResult.messages,
              isDone: isDone
          };
          
          // Deduct credits for token usage
          if (site_id && result.usage && ((result.usage as any).promptTokens || (result.usage as any).input_tokens)) {
            const totalTokens = ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0) + 
                                ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0);
            
            const tokensCost = (totalTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_TOKEN_MILLION;
            
            if (tokensCost > 0) {
              try {
                await CreditService.deductCredits(
                  site_id,
                  tokensCost,
                  'assistant_tokens',
                  `Assistant step execution (${totalTokens} tokens)`,
                  {
                    tokens: totalTokens,
                    input_tokens: ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0),
                    output_tokens: ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0)
                  }
                );
              } catch (e) {
                console.error('Failed to deduct credits for assistant tokens:', e);
              }
            }
          }
          
          return result;
  } catch (error: any) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing assistant step:`, error);
      throw error;
  }
}

/**
 * Execute assistant with OpenAI/Azure (no Scrapybara tools)
 */
export async function executeAssistant(
  prompt: string,
  instance?: any,
  options?: AssistantExecutionOptions
): Promise<AssistantExecutionResult> {
  const {
    use_sdk_tools = false,
    system_prompt = 'You are a helpful AI assistant. Provide clear and concise responses.',
    custom_tools = [],
    instance_id,
    site_id,
    user_id,
  } = options || {};
  
  const provider = options.provider || process.env.ROBOT_SDK_PROVIDER || 'gemini';

  if (site_id) {
    try {
      const hasCredits = await CreditService.validateCredits(site_id, 0.001); // minimal requirement to start
      if (!hasCredits) {
        throw new InsufficientCreditsError('Insufficient credits for assistant execution');
      }
    } catch (e: any) {
      console.error('Credit validation failed:', e.message);
      throw e;
    }
  }

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Executing assistant with provider: ${provider}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Use SDK tools: ${use_sdk_tools}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Custom tools: ${custom_tools.length}`);
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ System prompt: ${system_prompt.substring(0, 200)}...`);

  try {
    let result: AssistantExecutionResult;
    
    // Reuse prepareAssistantTools logic implicitly or explicitly?
    // Using prepareAssistantTools would be cleaner but let's stick to the original implementation 
    // pattern to be absolutely safe, but I'll use the extracted logic if I can.
    // Actually, I'll copy the logic back or use the new helper. 
    // Using the new helper is better for consistency.
    
    const prepared = await prepareAssistantTools(instance, options || {});

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Using AI assistant without Scrapybara tools`);

    const executor = new AIAgentExecutor({
      provider: options.ai_provider,
      model: options.ai_model,
    });
    const streamingCallbacks =
      instance_id && site_id
        ? createStreamingLogCallbacks(instance_id, site_id, user_id, provider)
        : undefined;
    const thinkingStreamCallbacks =
      instance_id && site_id
        ? createThinkingStreamLogCallbacks(instance_id, site_id, user_id, provider)
        : undefined;

    const executionResult = await executor.act({
        tools: prepared.tools, // Use tools from prepared
        system: system_prompt,
        prompt: prompt,
        onStep: createAssistantOnStepHandler(instance_id, site_id, user_id, provider),
        stream: !!streamingCallbacks,
        onStreamStart: streamingCallbacks?.onStreamStart,
        onStreamChunk: streamingCallbacks?.onStreamChunk,
        onThinkingStreamStart: thinkingStreamCallbacks?.onThinkingStreamStart,
        onThinkingStreamChunk: thinkingStreamCallbacks?.onThinkingStreamChunk,
        onReasoningTokensUsed: thinkingStreamCallbacks?.onReasoningTokensUsed,
      });

      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [EXECUTOR RESULT] Text length: ${executionResult.text?.length || 0}`);
      
      let responseText = executionResult.text || '';
      if (!responseText && executionResult.messages && executionResult.messages.length > 0) {
        const lastMessage = executionResult.messages[executionResult.messages.length - 1];
        if (lastMessage.role === 'assistant' && lastMessage.content) {
          responseText = lastMessage.content;
        }
      }

    result = {
      text: responseText,
      output: executionResult.output || null,
      usage: executionResult.usage || {},
      steps: executionResult.steps || [],
    };

    if (instance_id) {

      // Deduct credits for token usage
      let tokensCost = 0;
      if (result.usage && ((result.usage as any).promptTokens || (result.usage as any).input_tokens)) {
        const totalTokens = ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0) + 
                            ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0);
        
        tokensCost = (totalTokens / 1_000_000) * CreditService.PRICING.ASSISTANT_TOKEN_MILLION;
        
        if (tokensCost > 0 && site_id) {
          try {
            await CreditService.deductCredits(
              site_id,
              tokensCost,
              'assistant_tokens',
              `Assistant execution (${totalTokens} tokens)`,
              {
                tokens: totalTokens,
                input_tokens: ((result.usage as any).promptTokens || (result.usage as any).input_tokens || 0),
                output_tokens: ((result.usage as any).completionTokens || (result.usage as any).output_tokens || 0)
              }
            );
          } catch (e) {
            console.error('Failed to deduct credits for assistant tokens:', e);
          }
        }
      }

      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'execution_summary',
        level: 'info',
        message: `Assistant execution completed: ${result.text.substring(0, 200)}`,
        details: {
          provider,
          use_sdk_tools,
          custom_tools_count: custom_tools.length,
          prompt_length: prompt.length,
          response_length: result.text.length,
          steps_count: result.steps?.length || 0,
        },
        instance_id: instance_id,
        site_id: site_id,
        user_id: user_id,
        tokens_used: result.usage,
      });
    }

    return result;
  } catch (error: any) {
    console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing assistant:`, error);

    if (instance_id) {
      await supabaseAdmin.from('instance_logs').insert({
        log_type: 'error',
        level: 'error',
        message: `Assistant execution failed: ${error.message}`,
        details: {
          error: error.message,
          stack: error.stack,
          provider,
        },
        instance_id: instance_id,
        site_id: site_id,
        user_id: user_id,
      });
    }

    throw error;
  }
}
