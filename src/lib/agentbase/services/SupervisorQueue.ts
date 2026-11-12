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
import { SupervisorPresentation } from './SupervisorPresentation';

export class SupervisorQueue extends SupervisorPresentation {
protected isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

protected async getCommandDbUuid(internalId: string): Promise<string | null> {
    try {
      // Try to get the command
      const command = await this.commandService.getCommandById(internalId);

      // Check metadata
      if (command && command.metadata && command.metadata.dbUuid) {
        if (this.isValidUUID(command.metadata.dbUuid)) {
          console.log(`[SupervisorService] UUID found in metadata: ${command.metadata.dbUuid}`);
          return command.metadata.dbUuid;
        }
      }

      // Try to access internal translation map
      try {
        // @ts-ignore - Accessing internal properties
        const idMap = (this.commandService as any).idTranslationMap;
        if (idMap && idMap.get && idMap.get(internalId)) {
          const mappedId = idMap.get(internalId);
          if (this.isValidUUID(mappedId)) {
            console.log(`[SupervisorService] UUID found in internal map: ${mappedId}`);
            return mappedId;
          }
        }
      } catch (err) {
        console.log('[SupervisorService] Could not access internal translation map');
      }

      // Search in database directly
      if (command) {
        const { data, error } = await supabaseAdmin
          .from('commands')
          .select('id')
          .eq('task', command.task)
          .eq('user_id', command.user_id)
          .eq('status', command.status)
          .order('created_at', { ascending: false })
          .limit(1);

        if (!error && data && data.length > 0) {
          console.log(`[SupervisorService] UUID found in direct search: ${data[0].id}`);
          return data[0].id;
        }
      }

      return null;
    } catch (error) {
      console.error('[SupervisorService] Error getting database UUID:', error);
      return null;
    }
  }

protected async waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000): Promise<{command: any, dbUuid: string | null, completed: boolean}> {
    let executedCommand = null;
    let attempts = 0;
    let dbUuid: string | null = null;

    console.log(`[SupervisorService] Waiting for command ${commandId} to complete...`);

    return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
      const checkInterval = setInterval(async () => {
        attempts++;

        try {
          executedCommand = await this.commandService.getCommandById(commandId, { fresh: true });

          if (!executedCommand) {
            console.log(`[SupervisorService] Command ${commandId} not found`);
            clearInterval(checkInterval);
            resolve({command: null, dbUuid: null, completed: false});
            return;
          }

          // Save database UUID if available
          if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
            dbUuid = executedCommand.metadata.dbUuid as string;
            console.log(`[SupervisorService] Database UUID found in metadata: ${dbUuid}`);
          }

          if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
            console.log(`[SupervisorService] Command ${commandId} completed with status: ${executedCommand.status}`);

            // Try to get UUID if we don't have it yet
            if (!dbUuid || !this.isValidUUID(dbUuid)) {
              dbUuid = await this.getCommandDbUuid(commandId);
              console.log(`[SupervisorService] UUID obtained after completion: ${dbUuid || 'Not found'}`);
            }

            clearInterval(checkInterval);
            resolve({command: executedCommand, dbUuid, completed: executedCommand.status === 'completed'});
            return;
          }

          console.log(`[SupervisorService] Command ${commandId} still running (status: ${executedCommand.status}), attempt ${attempts}/${maxAttempts}`);

          if (attempts >= maxAttempts) {
            console.log(`[SupervisorService] Timeout waiting for command ${commandId}`);

            // Last attempt to get UUID
            if (!dbUuid || !this.isValidUUID(dbUuid)) {
              dbUuid = await this.getCommandDbUuid(commandId);
              console.log(`[SupervisorService] UUID obtained before timeout: ${dbUuid || 'Not found'}`);
            }

            clearInterval(checkInterval);
            resolve({command: executedCommand, dbUuid, completed: false});
          }
        } catch (error) {
          console.error(`[SupervisorService] Error checking command ${commandId} status:`, error);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
        }
      }, delayMs);
    });
  }

protected async filterSuggestionsWithGPT52(
    command: DbCommand,
    analysis: SupervisorAnalysis
  ): Promise<SupervisorAnalysis> {
    // If no suggestions, return as-is
    if (analysis.system_suggested_tools_for_development.length === 0 && analysis.prompt_suggestions.length === 0) {
      return analysis;
    }

    try {
      // Retrieve existing suggestions from memory
      const existingToolSuggestions = await this.getExistingToolSuggestions();
      const existingPromptSuggestions = await this.getExistingPromptSuggestions(command.agent_id, command.user_id);

      // If no existing suggestions, all new ones are valid
      if (existingToolSuggestions.length === 0 && existingPromptSuggestions.length === 0) {
        console.log('[SupervisorService] No existing suggestions in memory, keeping all new suggestions');
        return analysis;
      }

      // Call GPT-6.1 Sol for similarity analysis
      const userPrompt = formatSimilarityAnalysisPrompt(
        existingToolSuggestions,
        existingPromptSuggestions,
        analysis.system_suggested_tools_for_development,
        analysis.prompt_suggestions
      );

      const messages = [
        {
          role: 'system' as const,
          content: SIMILARITY_ANALYSIS_SYSTEM_PROMPT
        },
        {
          role: 'user' as const,
          content: userPrompt
        }
      ];

      console.log(`[SupervisorService] Calling ${getOpenRouterChatModel()} for similarity analysis...`);
      const response = await this.connector.callAgent(messages, {
        modelType: 'openrouter',
        modelId: getOpenRouterChatModel(),
        siteId: command.site_id,
        maxTokens: 32768,
        responseFormat: 'json',
        reasoningEffort: 'high',
        verbosity: 'medium'
      });

      // Parse the response
      let similarityResult: any;
      if (typeof response.content === 'string') {
        try {
          const content = response.content.trim();
          const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          similarityResult = JSON.parse(jsonContent);
        } catch (parseError) {
          console.error('[SupervisorService] Error parsing chat model similarity response:', parseError);
          // Fallback: keep all suggestions if parsing fails
          return analysis;
        }
      } else {
        similarityResult = response.content;
      }

      // Use filtered suggestions from GPT-6.1 Sol
      const filteredAnalysis = {
        ...analysis,
        system_suggested_tools_for_development: similarityResult.new_suggestions?.system_suggested_tools_for_development || [],
        prompt_suggestions: similarityResult.new_suggestions?.prompt_suggestions || []
      };

      console.log(`[SupervisorService] ${getOpenRouterChatModel()} filtered suggestions:`, {
        system_suggested_tools_for_development: `${analysis.system_suggested_tools_for_development.length} -> ${filteredAnalysis.system_suggested_tools_for_development.length}`,
        prompt_suggestions: `${analysis.prompt_suggestions.length} -> ${filteredAnalysis.prompt_suggestions.length}`,
        analysis: similarityResult.analysis
      });

      return filteredAnalysis;
    } catch (error: any) {
      console.error('[SupervisorService] Error in filterSuggestionsWithGPT52:', error);
      // Fallback: keep all suggestions if inference fails
      return analysis;
    }
  }
}
