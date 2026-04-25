import { supabaseAdmin } from '@/lib/database/supabase-client';
import { type NodeResult, buildInitialNodeResult } from './node-result-collector';

/**
 * Create onStep callback handler for assistant execution
 * Logs steps and tool calls in real-time during execution
 * When streamingLogId is provided, UPDATE that existing log instead of INSERT (streaming path)
 */
export function createAssistantOnStepHandler(
  instance_id: string | undefined,
  site_id: string | undefined,
  user_id: string | undefined,
  provider: string
) {
  return async (step: any, meta?: { streamingLogId?: string }) => {
    // Log step information
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT STEP] Text: ${step.text?.substring(0, 100) || 'No text'}...`);
    if (step.toolCalls?.length > 0) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ASSISTANT STEP] Tool calls: ${step.toolCalls.length}`);
    }

    // Only log if instance_id is provided
    if (!instance_id) {
      return;
    }

    const logMessage = step.text?.trim() || 'Assistant step execution';
    const logPayload = {
      message: logMessage,
      tokens_used: step.usage ? {
        promptTokens: step.usage.promptTokens || step.usage.input_tokens,
        completionTokens: step.usage.completionTokens || step.usage.output_tokens,
        totalTokens: step.usage.totalTokens || (step.usage.input_tokens + step.usage.output_tokens),
      } : {},
      details: {
        provider,
        response_type: 'assistant_step',
        raw_text: step.text,
        total_tool_calls: step.toolCalls?.length || 0,
      },
    };

    let parentLogId: string;

    if (meta?.streamingLogId) {
      // Streaming path: UPDATE the log we created during streaming
      const { error: updateError } = await supabaseAdmin
        .from('instance_logs')
        .update(logPayload)
        .eq('id', meta.streamingLogId);

      if (updateError) {
        console.error('❌ Error updating streaming assistant step log:', updateError);
        return;
      }
      parentLogId = meta.streamingLogId;
    } else {
      // Non-streaming path: INSERT new log
      const { data: parentLogData, error: parentLogError } = await supabaseAdmin
        .from('instance_logs')
        .insert({
          log_type: 'agent_action',
          level: 'info',
          ...logPayload,
          instance_id: instance_id,
          site_id: site_id,
          user_id: user_id,
        })
        .select()
        .single();

      if (parentLogError) {
        console.error('❌ Error saving assistant step log:', parentLogError);
        return;
      }
      parentLogId = parentLogData?.id;
    }

    // Log individual tool calls if any
    if (step.toolCalls && step.toolCalls.length > 0 && parentLogId) {
      let savedToolCalls = 0;
      let failedToolCalls = 0;

      for (const toolCall of step.toolCalls) {
        // Extract and save thought_process as a thinking log if present
        if (toolCall.args && typeof toolCall.args.thought_process === 'string' && toolCall.args.thought_process.trim() !== '') {
          const { error: thinkingLogError } = await supabaseAdmin.from('instance_logs').insert({
            log_type: 'thinking',
            level: 'info',
            message: toolCall.args.thought_process,
            details: {
              provider,
              response_type: 'reasoning',
              tool_name: toolCall.toolName,
              tool_call_id: toolCall.id || toolCall.toolCallId,
            },
            instance_id: instance_id,
            site_id: site_id,
            user_id: user_id,
            parent_log_id: parentLogId,
          });

          if (thinkingLogError) {
            console.error(`❌ Error saving thought_process log for ${toolCall.toolName}:`, thinkingLogError);
          } else {
            console.log(`₍ᐢ•(ܫ)•ᐢ₎ [THINKING] Saved thought_process for ${toolCall.toolName}`);
          }
        }

        // Find corresponding tool result
        const toolResult = step.toolResults?.find(
          (tr: any) => tr.toolCallId === toolCall.id || tr.toolCallId === toolCall.toolCallId
        );

        // Extract screenshot if it's a computer tool
        let screenshotBase64 = null;
        if (toolResult && toolCall.toolName === 'computer') {
          screenshotBase64 = toolResult.base64Image || null;
        }

        const { error: toolLogError } = await supabaseAdmin.from('instance_logs').insert({
          log_type: 'tool_call',
          level: 'info',
          message: `${toolCall.toolName}: ${toolCall.args ? Object.entries(toolCall.args).map(([k, v]) => `${k}=${v}`).join(', ') : 'no args'}`,
          tool_name: toolCall.toolName,
          tool_call_id: toolCall.id || toolCall.toolCallId,
          tool_args: toolCall.args || {},
          tool_result: toolResult ? {
            success: !toolResult.isError,
            output: (() => {
              // Clean output of any base64 image
              const rawOutput = toolResult.result || toolResult.content || '';
              if (typeof rawOutput === 'string') {
                if (rawOutput.includes('base64,')) {
                  return 'Screenshot captured successfully';
                }
                return rawOutput;
              }
              if (typeof rawOutput === 'object' && rawOutput !== null) {
                const cleanOutput = { ...rawOutput };
                delete cleanOutput.base64Image;
                return cleanOutput;
              }
              return rawOutput;
            })(),
            error: toolResult.isError ? (toolResult.error || toolResult.result) : null,
          } : {},
          screenshot_base64: screenshotBase64,
          parent_log_id: parentLogId,
          duration_ms: step.usage?.duration_ms || null,
          tokens_used: step.usage ? {
            promptTokens: step.usage.promptTokens || step.usage.input_tokens,
            completionTokens: step.usage.completionTokens || step.usage.output_tokens,
            totalTokens: step.usage.totalTokens || (step.usage.input_tokens + step.usage.output_tokens),
          } : {},
          details: {
            provider,
            response_type: 'assistant_tool_call',
            tool_sequence_number: step.toolCalls.indexOf(toolCall) + 1,
            total_tool_calls: step.toolCalls.length,
          },
          instance_id: instance_id,
          site_id: site_id,
          user_id: user_id,
        });

        if (toolLogError) {
          console.error(`❌ Error saving tool log for ${toolCall.toolName}:`, toolLogError);
          failedToolCalls++;
        } else {
          savedToolCalls++;
        }
      }

      if (savedToolCalls > 0 || failedToolCalls > 0) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Tool calls saved: ${savedToolCalls}/${step.toolCalls.length} (${failedToolCalls} failed)`);
      }
    }
  };
}

/**
 * Create streaming callbacks for real-time instance_log updates.
 */
export function createStreamingLogCallbacks(
  instance_id: string,
  site_id: string,
  user_id: string | undefined,
  provider: string
): { onStreamStart: () => Promise<string>; onStreamChunk: (logId: string, accumulatedText: string) => Promise<void> } {
  return {
    onStreamStart: async () => {
      const { data, error } = await supabaseAdmin
        .from('instance_logs')
        .insert({
          log_type: 'agent_action',
          level: 'info',
          message: '',
          details: { provider, response_type: 'assistant_step', streaming: true },
          instance_id,
          site_id,
          user_id,
        })
        .select('id')
        .single();
      if (error) {
        console.error('❌ Error creating streaming log:', error);
        throw new Error(`Failed to create streaming log: ${error.message}`);
      }
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STREAM] Created log ${data.id} for instance ${instance_id}`);
      return data.id;
    },
    onStreamChunk: async (logId: string, accumulatedText: string) => {
      const { error } = await supabaseAdmin
        .from('instance_logs')
        .update({ message: accumulatedText })
        .eq('id', logId);
      if (error) {
        console.error('❌ Error updating streaming log chunk:', error);
      }
    },
  };
}

export interface NodeContextRef {
  context_node_id: string;
  type: string; // 'result' | 'prompt' | 'summary' | custom
}

/**
 * Create streaming callbacks for instance_nodes (graph/workflow responses).
 * Creates a new response node as child of the prompt node,
 * then streams the LLM result into it.
 * Optionally links context nodes via instance_node_contexts.
 */
export function createNodeStreamingCallbacks(
  promptNodeId: string,
  promptNode: any,
  contextRefs?: NodeContextRef[]
): {
  onNodeStreamStart: () => Promise<string>;
  onNodeStreamChunk: (nodeId: string, accumulatedText: string) => Promise<void>;
  onNodeStreamEnd: (nodeId: string, result: NodeResult) => Promise<void>;
  onNodeStreamError: (nodeId: string | null, errorMessage: string) => Promise<void>;
} {
  const initialResult = buildInitialNodeResult(promptNode);

  return {
    onNodeStreamStart: async () => {
      const { data, error } = await supabaseAdmin
        .from('instance_nodes')
        .insert({
          instance_id: promptNode.instance_id,
          parent_node_id: promptNodeId,
          parent_instance_log_id: promptNode.parent_instance_log_id,
          type: 'response',
          prompt: promptNode.prompt,
          settings: promptNode.settings || {},
          status: 'running',
          result: initialResult,
          site_id: promptNode.site_id,
          user_id: promptNode.user_id,
        })
        .select('id')
        .single();
      if (error) {
        console.error('[Node Executor] Error creating response node:', error);
        throw new Error(`Failed to create response node: ${error.message}`);
      }

      const responseNodeId = data.id;
      console.log(`[Node Executor] Created response node ${responseNodeId} for prompt node ${promptNodeId}`);

      // Insert context relations (instance_node_contexts)
      if (contextRefs && contextRefs.length > 0) {
        const rows = contextRefs.map(ref => ({
          target_node_id: responseNodeId,
          context_node_id: ref.context_node_id,
          type: ref.type,
          site_id: promptNode.site_id,
          user_id: promptNode.user_id,
        }));
        const { error: ctxError } = await supabaseAdmin
          .from('instance_node_contexts')
          .insert(rows);
        if (ctxError) {
          console.error('[Node Executor] Error inserting context refs:', ctxError);
        } else {
          console.log(`[Node Executor] Linked ${rows.length} context nodes to response ${responseNodeId}`);
        }
      }

      return responseNodeId;
    },
    onNodeStreamChunk: async (nodeId: string, accumulatedText: string) => {
      const chunkResult: NodeResult = { text: accumulatedText, status: 'streaming' };
      if (initialResult.outputs) chunkResult.outputs = initialResult.outputs;
      const { error } = await supabaseAdmin
        .from('instance_nodes')
        .update({ result: chunkResult, updated_at: new Date().toISOString() })
        .eq('id', nodeId);
      if (error) console.error('[Node Executor] Stream chunk update error:', error);
    },
    onNodeStreamEnd: async (nodeId: string, result: NodeResult) => {
      const { error } = await supabaseAdmin
        .from('instance_nodes')
        .update({
          status: 'completed',
          result,
          updated_at: new Date().toISOString(),
        })
        .eq('id', nodeId);
      if (error) console.error('[Node Executor] Final update error:', error);
      else console.log(`[Node Executor] Completed response node ${nodeId}, text: ${result.text?.length || 0}, outputs: ${result.outputs?.length || 0}`);
    },
    onNodeStreamError: async (nodeId: string | null, errorMessage: string) => {
      if (!nodeId) return;
      await supabaseAdmin
        .from('instance_nodes')
        .update({
          status: 'failed',
          result: { error: errorMessage },
          updated_at: new Date().toISOString(),
        })
        .eq('id', nodeId);
      console.error(`[Node Executor] Node ${nodeId} failed: ${errorMessage}`);
    },
  };
}

/**
 * Fetch context nodes for a given target node from instance_node_contexts.
 * Returns the referenced nodes with their type, ordered by creation.
 */
export async function fetchNodeContexts(targetNodeId: string): Promise<{
  context_node_id: string;
  type: string;
  node: any;
}[]> {
  const { data: refs, error } = await supabaseAdmin
    .from('instance_node_contexts')
    .select('context_node_id, type')
    .eq('target_node_id', targetNodeId)
    .order('created_at', { ascending: true });

  if (error || !refs || refs.length === 0) return [];

  const nodeIds = refs.map(r => r.context_node_id);
  const { data: nodes } = await supabaseAdmin
    .from('instance_nodes')
    .select('*')
    .in('id', nodeIds);

  if (!nodes) return [];

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  return refs
    .filter(r => nodeMap.has(r.context_node_id))
    .map(r => ({
      context_node_id: r.context_node_id,
      type: r.type,
      node: nodeMap.get(r.context_node_id),
    }));
}

/**
 * Batch-create N response nodes as children of a prompt node.
 * Returns array of created node IDs. Optionally links context refs to each.
 */
export async function batchCreateResponseNodes(
  promptNodeId: string,
  promptNode: any,
  count: number,
  contextRefs?: NodeContextRef[]
): Promise<string[]> {
  const initialResult = buildInitialNodeResult(promptNode);
  const rows = Array.from({ length: count }, (_, i) => ({
    instance_id: promptNode.instance_id,
    parent_node_id: promptNodeId,
    parent_instance_log_id: promptNode.parent_instance_log_id,
    type: 'response',
    prompt: promptNode.prompt,
    settings: { ...promptNode.settings, result_index: i },
    status: 'running',
    result: initialResult,
    site_id: promptNode.site_id,
    user_id: promptNode.user_id,
  }));

  const { data, error } = await supabaseAdmin
    .from('instance_nodes')
    .insert(rows)
    .select('id');

  if (error || !data) {
    console.error('[Node Executor] Error batch-creating response nodes:', error);
    throw new Error(`Failed to batch-create response nodes: ${error?.message}`);
  }

  const nodeIds = data.map((d: any) => d.id);
  console.log(`[Node Executor] Batch-created ${nodeIds.length} response nodes for prompt ${promptNodeId}`);

  // Link context refs to each response node
  if (contextRefs && contextRefs.length > 0) {
    const ctxRows = nodeIds.flatMap((nodeId: string) =>
      contextRefs.map(ref => ({
        target_node_id: nodeId,
        context_node_id: ref.context_node_id,
        type: ref.type,
        site_id: promptNode.site_id,
        user_id: promptNode.user_id,
      }))
    );
    const { error: ctxError } = await supabaseAdmin
      .from('instance_node_contexts')
      .insert(ctxRows);
    if (ctxError) console.error('[Node Executor] Error inserting batch context refs:', ctxError);
  }

  return nodeIds;
}

/**
 * Update a single response node during streaming.
 */
export async function updateNodeResult(nodeId: string, result: NodeResult) {
  const { error } = await supabaseAdmin
    .from('instance_nodes')
    .update({
      result,
      status: result.status === 'done' ? 'completed' : 'running',
      updated_at: new Date().toISOString(),
    })
    .eq('id', nodeId);
  if (error) console.error(`[Node Executor] Update error for node ${nodeId}:`, error);
}

/**
 * Mark a response node as failed.
 */
export async function failNode(nodeId: string, errorMessage: string) {
  await supabaseAdmin
    .from('instance_nodes')
    .update({
      status: 'failed',
      result: { error: errorMessage },
      updated_at: new Date().toISOString(),
    })
    .eq('id', nodeId);
}

/**
 * Create streaming callbacks for reasoning/thinking content (o-series, etc).
 */
export function createThinkingStreamLogCallbacks(
  instance_id: string,
  site_id: string,
  user_id: string | undefined,
  provider: string
): {
  onThinkingStreamStart: () => Promise<string>;
  onThinkingStreamChunk: (logId: string, accumulatedText: string) => Promise<void>;
  onReasoningTokensUsed: (reasoningTokensCount: number) => Promise<void>;
} {
  return {
    onThinkingStreamStart: async () => {
      const { data, error } = await supabaseAdmin
        .from('instance_logs')
        .insert({
          log_type: 'thinking',
          level: 'info',
          message: '',
          details: { provider, response_type: 'reasoning', streaming: true },
          instance_id,
          site_id,
          user_id,
        })
        .select('id')
        .single();
      if (error) {
        console.error('❌ Error creating thinking streaming log:', error);
        throw new Error(`Failed to create thinking streaming log: ${error.message}`);
      }
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [THINKING] Created log ${data.id} for instance ${instance_id}`);
      return data.id;
    },
    onThinkingStreamChunk: async (logId: string, accumulatedText: string) => {
      const { error } = await supabaseAdmin
        .from('instance_logs')
        .update({ message: accumulatedText })
        .eq('id', logId);
      if (error) {
        console.error('❌ Error updating thinking streaming log chunk:', error);
      }
    },
    onReasoningTokensUsed: async (reasoningTokensCount: number) => {
      const { error } = await supabaseAdmin.from('instance_logs').insert({
        log_type: 'thinking',
        level: 'info',
        message: `Model used ${reasoningTokensCount} reasoning tokens.`,
        details: {
          provider,
          response_type: 'reasoning_tokens_fallback',
          reasoning_tokens: reasoningTokensCount,
        },
        instance_id,
        site_id,
        user_id,
      });
      if (error) {
        console.error('❌ Error creating reasoning tokens fallback log:', error);
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [THINKING] Created fallback log: ${reasoningTokensCount} reasoning tokens used`);
      }
    },
  };
}
