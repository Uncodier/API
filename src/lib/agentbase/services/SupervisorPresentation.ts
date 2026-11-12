import { DbCommand, CreateCommandParams } from '../models/types';
import { PortkeyConnector } from './PortkeyConnector';
import { PortkeyConfig } from '../models/types';
import {
  SUPERVISOR_SYSTEM_PROMPT,
  formatSupervisorPrompt,
  SIMILARITY_ANALYSIS_SYSTEM_PROMPT,
  formatSimilarityAnalysisPrompt
} from '../prompts/supervisor-prompt';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SendGridService } from '@/lib/services/sendgrid-service';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { SystemMemoryService } from '@/lib/services/system-memory-service';
import { CommandService } from '../adapters/CommandService';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { ProcessorInitializer } from '../services/processor/ProcessorInitializer';
import { CommandFactory } from '../services/command/CommandFactory';
import { v4 as uuidv4 } from 'uuid';
import { getOpenRouterChatModel } from '@/lib/services/ai/openrouter';
import type { SupervisorAnalysis, SupervisorResult } from './SupervisorTypes';
import { SupervisorMemory } from './SupervisorMemory';

export class SupervisorPresentation extends SupervisorMemory {
protected transformSupervisorResult(rawResult: any): SupervisorAnalysis {
    // Transform errata: might be strings or objects
    const transformedErrata: SupervisorAnalysis['errata'] = [];
    if (Array.isArray(rawResult.errata)) {
      for (const item of rawResult.errata) {
        if (typeof item === 'string') {
          // Convert string to errata object
          transformedErrata.push({
            message: item
          });
        } else if (item && typeof item === 'object' && item.message) {
          // Already an object, use it (only message field)
          transformedErrata.push({
            message: item.message
          });
        }
      }
    }

    // Transform system_suggested_tools_for_development: convert from {name, benefit, purpose} to {tool_name, description, use_case, priority, rationale}
    const transformedToolSuggestions: SupervisorAnalysis['system_suggested_tools_for_development'] = [];
    if (Array.isArray(rawResult.system_suggested_tools_for_development)) {
      for (const item of rawResult.system_suggested_tools_for_development) {
        if (item && typeof item === 'object') {
          transformedToolSuggestions.push({
            tool_name: item.name || item.tool_name || 'Unknown Tool',
            description: item.description || item.benefit || item.purpose || 'No description',
            use_case: item.use_case || item.purpose || 'No use case specified',
            priority: item.priority || 'medium',
            rationale: item.rationale || item.benefit || 'No rationale provided'
          });
        }
      }
    }

    // Transform prompt_suggestions: convert from strings to objects with context, improved_prompt, rationale, example
    const transformedPromptSuggestions: SupervisorAnalysis['prompt_suggestions'] = [];
    if (Array.isArray(rawResult.prompt_suggestions)) {
      for (const item of rawResult.prompt_suggestions) {
        if (typeof item === 'string') {
          // Convert string to prompt suggestion object
          transformedPromptSuggestions.push({
            context: 'General conversation context',
            improved_prompt: item,
            rationale: 'Improves response quality and user experience',
            example: ''
          });
        } else if (item && typeof item === 'object' && item.improved_prompt) {
          // Already an object, use it
          // Only use example if it's provided and different from improved_prompt
          const example = item.example && item.example !== item.improved_prompt
            ? item.example
            : '';
          transformedPromptSuggestions.push({
            context: item.context || 'General conversation context',
            improved_prompt: item.improved_prompt,
            rationale: item.rationale || 'Improves response quality and user experience',
            example: example
          });
        }
      }
    }

    // Ensure analysis object has all required fields
    const analysisObj = rawResult.analysis || {};

    return {
      analysis: {
        summary: analysisObj.summary || '',
        tools_available_count: analysisObj.tools_available_count || 0,
        tools_executed_count: analysisObj.tools_executed_count || 0,
        errors_detected: Array.isArray(analysisObj.errors_detected)
          ? analysisObj.errors_detected.map((error: any) => {
              if (typeof error === 'string') {
                return {
                  type: 'response_error',
                  description: error,
                  severity: 'medium' as const
                };
              }
              return {
                type: error.type || 'response_error',
                description: error.description || error.message || String(error),
                severity: (error.severity || 'medium') as 'high' | 'medium' | 'low'
              };
            })
          : []
      },
      errata: transformedErrata,
      system_suggested_tools_for_development: transformedToolSuggestions,
      prompt_suggestions: transformedPromptSuggestions
    };
  }

protected extractExecutedTools(results: any[]): any[] {
    const executedTools: any[] = [];

    for (const result of results) {
      if (result.type === 'tool_evaluation' && result.content) {
        const content = result.content;
        if (content.tools && Array.isArray(content.tools)) {
          // Extract tools from tool_evaluation results
          for (const tool of content.tools) {
            if (tool.name) {
              executedTools.push(tool);
            }
          }
        }
      } else if (result.type === 'function_call' || result.name) {
        // Direct function call result
        executedTools.push(result);
      }
    }

    return executedTools;
  }

protected async applyErrata(
    command: DbCommand,
    errata: SupervisorAnalysis['errata'],
    conversationId?: string
  ): Promise<number> {
    if (errata.length === 0) {
      return 0;
    }

    try {
      // Use provided conversation_id or try to extract from command
      const effectiveConversationId = conversationId || this.extractConversationId(command);

      if (!effectiveConversationId) {
        console.warn('[SupervisorService] No conversation ID found, cannot apply errata');
        return 0;
      }

      let appliedCount = 0;

      for (const erratum of errata) {
        // Skip if erratum is not a valid object with message field
        if (!erratum || typeof erratum !== 'object' || !erratum.message) {
          console.warn('[SupervisorService] Skipping invalid errata item:', erratum);
          continue;
        }

        // Use plain message text
        const errataMessage = erratum.message;

        // Add system message to conversation
        const customData: any = {
          supervisor_errata: true,
          command_id: command.id
        };

        const { error } = await supabaseAdmin
          .from('messages')
          .insert({
            conversation_id: effectiveConversationId,
            content: errataMessage,
            role: 'system',
            user_id: command.user_id,
            custom_data: customData
          });

        if (error) {
          console.error(`[SupervisorService] Error applying errata:`, error);
        } else {
          appliedCount++;
          console.log(`[SupervisorService] Applied errata to conversation ${effectiveConversationId}`);
        }
      }

      return appliedCount;
    } catch (error: any) {
      console.error('[SupervisorService] Error applying errata:', error);
      return 0;
    }
  }

protected async sendNotifications(
    command: DbCommand,
    analysis: SupervisorAnalysis
  ): Promise<number> {
    let emailsSent = 0;

    try {
      // Send tool suggestions to sysadmin
      if (analysis.system_suggested_tools_for_development.length > 0) {
        const toolSuggestionsEmail = this.formatToolSuggestionsEmail(
          command,
          analysis.system_suggested_tools_for_development
        );

        const emailResult = await this.sendGridService.sendEmail({
          to: 'sergio@uncodie.com',
          subject: `Supervisor: Missing Tools for Development - Command ${command.id.substring(0, 8)}`,
          html: toolSuggestionsEmail,
          categories: ['supervisor', 'tool_suggestions']
        });

        if (emailResult.success) {
          emailsSent++;
          console.log('[SupervisorService] Tool suggestions email sent to sysadmin');
        } else {
          console.error('[SupervisorService] Failed to send tool suggestions email:', emailResult.error);
        }
      }

      // Prompt suggestions email sending disabled - will be handled by a different workflow later
      // if (analysis.prompt_suggestions.length > 0 && command.site_id) {
      //   ...
      // }

      return emailsSent;
    } catch (error: any) {
      console.error('[SupervisorService] Error sending notifications:', error);
      return emailsSent;
    }
  }

protected extractAgentInfo(command: DbCommand): { name: string; role?: string; capabilities?: string[] } {
    const defaultInfo = { name: 'Agent', role: undefined, capabilities: [] };

    // Try to extract from agent_background
    if (command.agent_background) {
      try {
        const background = command.agent_background;

        // Extract agent name from "You are [Name] (ID: ...)" pattern
        const nameMatch = background.match(/You are ([^\(]+)\s*\(ID:/i);
        const name = nameMatch ? nameMatch[1].trim() : 'Agent';

        // Extract role from "# Description" section
        const descriptionMatch = background.match(/# Description\s*\n([^\n]+)/i);
        const role = descriptionMatch ? descriptionMatch[1].trim() : undefined;

        // Extract capabilities from "# Capabilities" section
        const capabilitiesMatch = background.match(/# Capabilities\s*\nYour capabilities include:\s*([^\n]+)/i);
        const capabilities = capabilitiesMatch
          ? capabilitiesMatch[1].split(',').map(c => c.trim()).filter(Boolean)
          : [];

        return { name, role, capabilities };
      } catch (error) {
        console.error('[SupervisorService] Error parsing agent_background:', error);
        return defaultInfo;
      }
    }

    // Fallback: use agent_id if available
    if (command.agent_id) {
      return { ...defaultInfo, name: `Agent ${command.agent_id.substring(0, 8)}` };
    }

    return defaultInfo;
  }

protected extractConversationId(command: DbCommand): string | null {
    // Try to extract from context
    if (command.context) {
      const contextMatch = command.context.match(/conversation[_-]?id["\s:]+([a-f0-9-]{36})/i);
      if (contextMatch) {
        return contextMatch[1];
      }
    }

    // Try to extract from results
    const results = command.results || [];
    for (const result of results) {
      if (result.conversation_id) {
        return result.conversation_id;
      }
      if (result.custom_data?.conversation_id) {
        return result.custom_data.conversation_id;
      }
    }

    return null;
  }

protected formatToolSuggestionsEmail(
    command: DbCommand,
    suggestions: SupervisorAnalysis['system_suggested_tools_for_development']
  ): string {
    const suggestionsHtml = suggestions.map((suggestion, index) => `
      <div style="margin-bottom: 20px; padding: 15px; border-left: 4px solid #4CAF50; background-color: #f9f9f9;">
        <h3 style="margin-top: 0; color: #333;">${index + 1}. ${suggestion.tool_name}</h3>
        <p><strong>Description:</strong> ${suggestion.description}</p>
        <p><strong>Use Case:</strong> ${suggestion.use_case}</p>
        <p><strong>Priority:</strong> <span style="color: ${suggestion.priority === 'high' ? 'red' : suggestion.priority === 'medium' ? 'orange' : 'blue'}">${suggestion.priority.toUpperCase()}</span></p>
        <p><strong>Rationale:</strong> ${suggestion.rationale}</p>
      </div>
    `).join('');

    return `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>System Suggested Tools for Development</h2>
          <p>The supervisor has analyzed command <strong>${command.id}</strong> and identified ${suggestions.length} tool(s) that are <strong>missing from the system</strong> and should be developed to improve system capabilities:</p>
          <p style="background-color: #fff3cd; padding: 10px; border-left: 4px solid #ffc107; margin: 15px 0;">
            <strong>Note:</strong> These are NOT tools that should have been called during execution, but rather tools that the supervisor considers are missing from the system and should be developed for future use.
          </p>
          ${suggestionsHtml}
          <hr style="margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">
            Command ID: ${command.id}<br>
            Task: ${command.task}<br>
            Generated: ${new Date().toISOString()}
          </p>
        </body>
      </html>
    `;
  }

protected formatPromptSuggestionsEmail(
    command: DbCommand,
    suggestions: SupervisorAnalysis['prompt_suggestions'],
    agentInfo: { name: string; role?: string; capabilities?: string[] }
  ): string {
    const suggestionsHtml = suggestions.map((suggestion, index) => `
      <div style="margin-bottom: 20px; padding: 15px; border-left: 4px solid #2196F3; background-color: #f0f8ff;">
        <h3 style="margin-top: 0; color: #333;">${index + 1}. Context: ${suggestion.context}</h3>
        <p><strong>Improved Prompt:</strong></p>
        <pre style="background-color: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto;">${suggestion.improved_prompt}</pre>
        <p><strong>Rationale:</strong> ${suggestion.rationale}</p>
      </div>
    `).join('');

    const agentCapabilities = agentInfo.capabilities && agentInfo.capabilities.length > 0
      ? `<p><strong>Agent Capabilities:</strong> ${agentInfo.capabilities.join(', ')}</p>`
      : '';

    return `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="background-color: #f0f8ff; padding: 15px; border-radius: 4px; margin-bottom: 20px; border-left: 4px solid #2196F3;">
            <h3 style="margin-top: 0; color: #2196F3;">Agent: ${agentInfo.name}</h3>
            ${agentInfo.role ? `<p><strong>Role:</strong> ${agentInfo.role}</p>` : ''}
            ${agentCapabilities}
          </div>
          <h2>Supervisor Prompt Improvement Suggestions</h2>
          <p>Analyzing the conversation, a more effective response could have been achieved with these improved prompts:</p>
          ${suggestionsHtml}
          <hr style="margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">
            Command ID: ${command.id}<br>
            Task: ${command.task}<br>
            Agent ID: ${command.agent_id || 'N/A'}<br>
            Generated: ${new Date().toISOString()}
          </p>
        </body>
      </html>
    `;
  }
}
