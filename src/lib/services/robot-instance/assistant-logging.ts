import { supabaseAdmin } from '@/lib/database/supabase-client';

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
