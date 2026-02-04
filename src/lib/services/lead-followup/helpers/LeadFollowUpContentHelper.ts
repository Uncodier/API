// Helper functions for content extraction and validation in LeadFollowUpService

export function validateToolExecutionResults(toolResults: any[]) {
    console.log(`🔧 PHASE 1: Validating ${toolResults.length} tool execution results`);
    
    toolResults.forEach((toolResult: any, index: number) => {
      const toolName = toolResult.function_name || toolResult.name || 'unknown';
      const toolStatus = toolResult.status || 'unknown';
      
      console.log(`🔧 PHASE 1: Tool #${index + 1} (${toolName}): status=${toolStatus}`);
      
      if (toolStatus === 'error' || toolStatus === 'failed') {
        console.warn(`⚠️ PHASE 1: Tool ${toolName} execution failed:`, toolResult.error);
      } else if (toolStatus === 'success') {
        // Validate that output is not malformed
        if (toolResult.output) {
          try {
            const outputStr = typeof toolResult.output === 'string' 
              ? toolResult.output 
              : JSON.stringify(toolResult.output);
            
            if (outputStr.length > 10 * 1024 * 1024) {
              console.warn(`⚠️ PHASE 1: Tool ${toolName} output is very large (${Math.round(outputStr.length / 1024)}KB)`);
            }
            
            // Check for malformed responses (duplicate objects with string values)
            if (typeof toolResult.output === 'object' && !Array.isArray(toolResult.output)) {
              const outputKeys = Object.keys(toolResult.output);
              const hasStringValues = outputKeys.some(key => 
                typeof toolResult.output[key] === 'string' && 
                ['success', 'lead', 'status_changed', 'status_change', 'next_actions'].includes(toolResult.output[key])
              );
              
              if (hasStringValues) {
                console.warn(`⚠️ PHASE 1: Tool ${toolName} output appears to have malformed response structure`);
              }
            }
          } catch (validationError: any) {
            console.warn(`⚠️ PHASE 1: Error validating tool ${toolName} output:`, validationError.message);
          }
        }
      }
    });
}

export function extractSalesFollowUpContent(completedSalesCommand: any, requestId: string): any {
  let salesFollowUpContent = null;
  if (completedSalesCommand.results && Array.isArray(completedSalesCommand.results)) {
    console.log(`[LeadFollowUp:${requestId}] 📋 Extracting content from ${completedSalesCommand.results.length} result(s)`);
    
    for (const result of completedSalesCommand.results) {
      
      // Search for follow_up_content (now expecting object, not array)
      if (result.follow_up_content && typeof result.follow_up_content === 'object' && !Array.isArray(result.follow_up_content)) {
        salesFollowUpContent = result.follow_up_content;
        console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (object):`, {
          hasChannel: !!salesFollowUpContent.channel,
          channel: salesFollowUpContent.channel
        });
        break;
      }
      
      // 🔧 FALLBACK: Handle flattened structure (temporary workaround)
      if (result.channel && result.title && result.message) {
        salesFollowUpContent = {
          channel: result.channel,
          title: result.title,
          message: result.message,
          strategy: result.strategy || '',
          message_language: result.message_language || 'en'
        };
        console.log(`[LeadFollowUp:${requestId}] ⚠️ Found flattened structure (fallback):`, {
          hasChannel: !!salesFollowUpContent.channel,
          channel: salesFollowUpContent.channel
        });
        break;
      }
      
      // Search for other possible structures
      if (result.content && typeof result.content === 'object' && !Array.isArray(result.content)) {
        salesFollowUpContent = result.content;
        console.log(`[LeadFollowUp:${requestId}] ✅ Found content (object):`, {
          hasChannel: !!salesFollowUpContent.channel,
          channel: salesFollowUpContent.channel
        });
        break;
      }
      
      // Legacy support for array format (convert first element)
      if (result.follow_up_content && Array.isArray(result.follow_up_content) && result.follow_up_content.length > 0) {
        salesFollowUpContent = result.follow_up_content[0];
        console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (array, using first):`, {
          hasChannel: !!salesFollowUpContent.channel,
          channel: salesFollowUpContent.channel
        });
        break;
      }
    }
  }
  return salesFollowUpContent;
}

export function createFallbackContent(completedSalesCommand: any, availableChannels: string[]): any {
    const errorResult = completedSalesCommand.results?.find((r: any) => r.error || r.error_type);
    if (errorResult) {
      // Validate that we have at least one available channel (should never be empty after early validation)
      if (availableChannels.length === 0) {
        console.error(`❌ CRITICAL: availableChannels is empty in createFallbackContent - this should never happen after early validation`);
        throw {
          code: 'NO_AVAILABLE_CHANNELS',
          message: 'No available channels found for fallback content. This indicates a system validation error.',
          status: 500
        };
      }
      
      // Use first available channel from validated list
      const fallbackChannel = availableChannels[0];
      
      return {
        strategy: "Follow-up strategy (generated after tool execution error)",
        title: "Personalized Follow-up",
        message: "Thank you for your interest. We'd like to follow up on your inquiry and provide you with more information that might be helpful.",
        channel: fallbackChannel,
        _metadata: {
          fallback: true,
          original_error: errorResult.error_type || completedSalesCommand.error,
          command_status: completedSalesCommand.status,
          generated_at: new Date().toISOString(),
          fallback_channel_source: 'availableChannels'
        }
      };
    }
    return null;
}

export function extractFinalContent(finalCommand: any, copywriterCompleted: boolean, salesFollowUpContent: any, requestId: string, availableChannels: string[]): any[] {
  let finalContent: any[] = [];
  
  console.log(`[LeadFollowUp:${requestId}] 📦 Extracting final content from ${copywriterCompleted ? 'copywriter' : 'sales'} command`);
  
  // Helper function to normalize channel names (agent_email -> email, agent_whatsapp -> whatsapp)
  // Also normalizes to lowercase to handle case variations (Email -> email, EMAIL -> email)
  const normalizeChannel = (channel: string | undefined): string | undefined => {
    if (!channel) return undefined;
    const lowerChannel = channel.toLowerCase();
    if (lowerChannel === 'agent_email') return 'email';
    if (lowerChannel === 'agent_whatsapp') return 'whatsapp';
    return lowerChannel;
  };
  
  // Helper function to get a valid fallback channel from availableChannels
  const getValidFallbackChannel = (): string => {
    // Validate that we have at least one available channel (should never be empty after early validation)
    if (availableChannels.length === 0) {
      console.error(`❌ CRITICAL: availableChannels is empty in getValidFallbackChannel - this should never happen after early validation`);
      throw {
        code: 'NO_AVAILABLE_CHANNELS',
        message: 'No available channels found for fallback. This indicates a system validation error.',
        status: 500
      };
    }
    
    // Prefer notification or web as they're always available and don't require contact info
    const preferredFallback = availableChannels.find(ch => ch === 'notification' || ch === 'web');
    if (preferredFallback) return preferredFallback;
    
    // Otherwise use first available channel from validated list
    return availableChannels[0];
  };
  
  // Extract content from final command
  if (finalCommand && finalCommand.results && Array.isArray(finalCommand.results)) {
    console.log(`[LeadFollowUp:${requestId}] 📋 Processing ${finalCommand.results.length} result(s) from final command`);
    
    for (const result of finalCommand.results) {
      
      // For copywriter, search for refined_content (can be object or array) or flattened fields
      if (copywriterCompleted) {
        // CRITICAL: Always preserve channel from sales content - copywriter does not return channel
        // Normalize channel name and validate it's in availableChannels
        let preservedChannel = normalizeChannel(salesFollowUpContent?.channel);
        
        // If channel is not in availableChannels, use a valid fallback
        if (!preservedChannel || !availableChannels.includes(preservedChannel)) {
          const fallbackChannel = getValidFallbackChannel();
          console.log(`[LeadFollowUp:${requestId}] ⚠️ Sales channel '${preservedChannel || 'undefined'}' not in availableChannels [${availableChannels.join(', ')}], using fallback: ${fallbackChannel}`);
          preservedChannel = fallbackChannel;
        }
        
        if (result.refined_content) {
          if (Array.isArray(result.refined_content)) {
            // Always use preserved channel - copywriter should not modify channels
            // Remove any channel that copywriter might have returned
            finalContent = result.refined_content.map((item: any) => {
              const { channel: _, ...itemWithoutChannel } = item;
              return {
                ...itemWithoutChannel,
                channel: preservedChannel
              };
            });
          } else if (typeof result.refined_content === 'object') {
            // Always use preserved channel - copywriter should not modify channels
            // Remove any channel that copywriter might have returned
            const { channel: _, ...contentWithoutChannel } = result.refined_content;
            finalContent = [{
              ...contentWithoutChannel,
              channel: preservedChannel
            }];
          }
          break;
        }
        // Handle flattened fields (new format)
        else if (result.refined_title && result.refined_message) {
           finalContent = [{
              channel: preservedChannel, // Always use sales channel - copywriter doesn't modify it
              title: result.refined_title,
              message: result.refined_message
           }];
           console.log(`[LeadFollowUp:${requestId}] ✅ Found flattened refined content:`, {
              hasChannel: !!finalContent[0].channel,
              channel: finalContent[0].channel,
              note: 'Channel preserved from sales content'
           });
           break;
        }
      }
      // For sales, search for follow_up_content (can be object or array)
      else if (!copywriterCompleted && result.follow_up_content) {
        if (Array.isArray(result.follow_up_content)) {
          finalContent = result.follow_up_content;
        } else if (typeof result.follow_up_content === 'object') {
          finalContent = [result.follow_up_content]; // Convert object to array
        }
        break;
      }
      // 🔧 FALLBACK: Handle flattened structure for final extraction (temporary workaround)
      // CRITICAL FIX: Ensure this fallback DOES NOT trigger for copywriter results
      else if (!copywriterCompleted && result.channel && result.title && result.message) {
        finalContent = [{
          channel: result.channel,
          title: result.title,
          message: result.message,
          strategy: result.strategy || '',
          message_language: result.message_language || 'en'
        }];
        console.log(`[LeadFollowUp:${requestId}] ⚠️ Found flattened structure in final extraction (fallback):`, {
          channel: result.channel,
          note: 'Structure was flattened by agentbase, using fallback extraction'
        });
        break;
      }
      // Fallbacks
      else if (result.content && Array.isArray(result.content)) {
        finalContent = result.content;
        break;
      }
      else if (result.content && typeof result.content === 'object') {
        finalContent = [result.content]; // Convert object to array
        break;
      }
      else if (Array.isArray(result)) {
        finalContent = result;
        break;
      }
    }
  }
  
  // 🔧 FALLBACK: Si finalContent está vacío pero tenemos salesFollowUpContent, usarlo
  if ((!finalContent || finalContent.length === 0) && salesFollowUpContent && typeof salesFollowUpContent === 'object') {
    console.log(`[LeadFollowUp:${requestId}] 🔧 Using salesFollowUpContent as fallback`);
    finalContent = [salesFollowUpContent];
  }
  
  // 🔧 VALIDATION: Ensure all content items have a valid channel
  if (finalContent && finalContent.length > 0) {
    finalContent = finalContent.map((item: any) => {
      if (!item.channel) {
        // Try to use sales channel, but validate it's in availableChannels
        let channelToUse = normalizeChannel(salesFollowUpContent?.channel);
        
        if (!channelToUse || !availableChannels.includes(channelToUse)) {
          channelToUse = getValidFallbackChannel();
          console.log(`[LeadFollowUp:${requestId}] ⚠️ Missing or invalid channel in content item, using fallback: ${channelToUse}`);
        } else {
          console.log(`[LeadFollowUp:${requestId}] ⚠️ Missing channel in content item, using sales channel: ${channelToUse}`);
        }
        
        return {
          ...item,
          channel: channelToUse
        };
      } else {
        // Normalize and validate existing channel
        const normalizedChannel = normalizeChannel(item.channel);
        if (!normalizedChannel || !availableChannels.includes(normalizedChannel)) {
          const fallbackChannel = getValidFallbackChannel();
          console.log(`[LeadFollowUp:${requestId}] ⚠️ Invalid channel '${item.channel}' in content item, using fallback: ${fallbackChannel}`);
          return {
            ...item,
            channel: fallbackChannel
          };
        }
        // Update channel to normalized version if it was agent_email/agent_whatsapp
        if (normalizedChannel !== item.channel) {
          return {
            ...item,
            channel: normalizedChannel
          };
        }
      }
      return item;
    });
  }
  
  return finalContent;
}

export function organizeMessagesByChannel(finalContent: any[], hasEmail: boolean, hasPhone: boolean, channelConfig: any, requestId: string): any {
  const messages: any = {};
  
  if (finalContent && Array.isArray(finalContent)) {
    finalContent.forEach((item: any, index: number) => {
      
      if (item.channel) {
        messages[item.channel] = {
          title: item.title || '',
          message: item.message || '',
          strategy: item.strategy || ''
        };
      } else {
        // 🔧 Channel inference: If content has title and message but no channel, infer from context
        if (item.title && item.message) {
          let inferredChannel: string | null = null;
          
          // Prefer email if lead has email and email is configured
          if (hasEmail && channelConfig.configuredChannels.includes('email')) {
            inferredChannel = 'email';
          }
          // Prefer whatsapp if lead has phone and whatsapp is configured
          else if (hasPhone && channelConfig.configuredChannels.includes('whatsapp')) {
            inferredChannel = 'whatsapp';
          }
          // Fallback to first configured channel
          else if (channelConfig.configuredChannels.length > 0) {
            inferredChannel = channelConfig.configuredChannels[0];
          }
          
          if (inferredChannel) {
            messages[inferredChannel] = {
              title: item.title || '',
              message: item.message || '',
              strategy: item.strategy || '',
              _metadata: {
                channel_inferred: true,
                original_channel: null
              }
            };
            console.log(`[LeadFollowUp:${requestId}] ⚠️ Item ${index} had no channel, inferred: ${inferredChannel}`);
          }
        }
      }
    });
  }
  return messages;
}

export function buildDiagnosticInfo(completedSalesCommand: any, channelConfig: any, salesFollowUpContent: any, finalContent: any[], requestId: string): any {
    const diagnosticInfo: any = {
        command_status: completedSalesCommand?.status || 'unknown',
        has_results: !!(completedSalesCommand?.results && completedSalesCommand.results.length > 0),
        results_count: completedSalesCommand?.results?.length || 0,
        configured_channels: channelConfig.configuredChannels,
        trace_id: requestId
      };
      
      // Add detailed results structure
      if (completedSalesCommand?.results) {
        diagnosticInfo.results_structure = completedSalesCommand.results.map((r: any) => ({
          keys: Object.keys(r),
          has_follow_up_content: !!r.follow_up_content,
          has_channel: !!r.channel,
          has_title: !!r.title,
          has_message: !!r.message,
          sample_keys: Object.keys(r).slice(0, 10)
        }));
      }
      
      // Add extraction attempt info
      diagnosticInfo.extraction_attempts = {
        checked_follow_up_content: true,
        checked_flattened_structure: true,
        checked_content_field: true,
        sales_content_found: !!salesFollowUpContent,
        sales_content_channel: salesFollowUpContent?.channel || null,
        final_content_length: finalContent?.length || 0
      };
      return diagnosticInfo;
}

export function buildToolExecutionMetadata(functions: any[], toolExecutionFailed: boolean, toolExecutionError: any): any {
    const toolsExecuted = functions.length;
    const toolsFailed = functions.filter((f: any) => f.status === 'failed' || f.status === 'error').length;
    const toolsCompleted = functions.filter((f: any) => f.status === 'completed' || f.status === 'success').length;
    
    const toolErrors: string[] = [];
    functions.forEach((f: any) => {
      if ((f.status === 'failed' || f.status === 'error') && f.error) {
        const toolName = f.name || f.function_name || 'unknown';
        const errorMsg = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
        toolErrors.push(`${toolName}: ${errorMsg.substring(0, 200)}`); // Limit error message length
      }
    });
    
    return {
      total: toolsExecuted,
      completed: toolsCompleted,
      failed: toolsFailed,
      errors: toolErrors,
      execution_failed: toolExecutionFailed,
      execution_error: toolExecutionError ? (typeof toolExecutionError === 'string' ? toolExecutionError : JSON.stringify(toolExecutionError)).substring(0, 500) : null
    };
}
