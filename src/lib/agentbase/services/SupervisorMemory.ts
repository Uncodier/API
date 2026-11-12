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

export class SupervisorMemory {
protected connector: PortkeyConnector;

protected sendGridService: SendGridService;

protected processorInitializer: ProcessorInitializer;

protected commandService: any;

constructor() {
    // Initialize ProcessorInitializer to access CommandService
    this.processorInitializer = ProcessorInitializer.getInstance();
    this.processorInitializer.initialize();
    this.commandService = this.processorInitializer.getCommandService();
    // Use the same OpenRouter account and model defaults as other agents.
    const portkeyConfig: PortkeyConfig = {
      // Credentials are resolved at dispatch inside the restored host scope.
    };

    this.connector = new PortkeyConnector(portkeyConfig, {
      modelType: 'openrouter',
      modelId: getOpenRouterChatModel(),
      maxTokens: 32768,
      temperature: 1, // GPT-6.1 Sol uses default temperature
      reasoningEffort: 'high',
      verbosity: 'medium'
    });

    // Initialize SendGrid service
    this.sendGridService = SendGridService.getInstance();
    try {
      this.sendGridService.initialize();
    } catch (error) {
      console.warn('SendGrid service not initialized, email notifications may not work');
    }
  }

protected async getSystemMemoryForContext(siteId?: string): Promise<any> {
    try {
      if (!siteId) {
        return null;
      }

      const systemMemoryService = new SystemMemoryService();

      // Get supervisor tool suggestions
      const toolSuggestionsMemory = await systemMemoryService.findMemoriesGlobal(
        'supervisor_tool_suggestions',
        'tool_suggestions'
      );

      const result: any = {
        system_suggested_tools_for_development: null
      };

      if (toolSuggestionsMemory.success && toolSuggestionsMemory.memories && toolSuggestionsMemory.memories.length > 0) {
        const latestMemory = toolSuggestionsMemory.memories[0];
        result.system_suggested_tools_for_development = latestMemory.data?.suggestions || [];
      }

      return result;
    } catch (error: any) {
      console.error('[SupervisorService] Error getting system memory for context:', error);
      return null;
    }
  }

protected async getAgentMemoryForContext(agentId?: string, userId?: string): Promise<any> {
    try {
      if (!agentId || !userId) {
        return null;
      }

      const result: any = {
        prompt_suggestions: []
      };

      // Get supervisor prompt suggestions
      const { data: memory, error } = await supabaseAdmin
        .from('agent_memories')
        .select('data')
        .eq('agent_id', agentId)
        .eq('user_id', userId)
        .eq('type', 'supervisor_prompt_suggestions')
        .eq('key', `prompt_suggestions_${agentId}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error('[SupervisorService] Error getting agent memory for context:', error);
        return result;
      }

      if (memory && memory.data) {
        result.prompt_suggestions = memory.data.suggestions || [];
      }

      return result;
    } catch (error: any) {
      console.error('[SupervisorService] Error getting agent memory for context:', error);
      return null;
    }
  }

protected async getExistingToolSuggestions(): Promise<any[]> {
    try {
      const systemMemoryService = new SystemMemoryService();
      const memoryResult = await systemMemoryService.findMemoriesGlobal(
        'supervisor_tool_suggestions',
        'tool_suggestions'
      );

      if (!memoryResult.success || !memoryResult.memories || memoryResult.memories.length === 0) {
        return [];
      }

      // Get suggestions from the most recent memory
      const latestMemory = memoryResult.memories[0];
      return latestMemory.data?.suggestions || [];
    } catch (error: any) {
      console.error('[SupervisorService] Error getting existing tool suggestions:', error);
      return [];
    }
  }

protected async getExistingPromptSuggestions(agentId?: string, userId?: string): Promise<any[]> {
    if (!agentId || !userId) {
      return [];
    }

    try {
      const { data: memory, error } = await supabaseAdmin
        .from('agent_memories')
        .select('data')
        .eq('agent_id', agentId)
        .eq('user_id', userId)
        .eq('type', 'supervisor_prompt_suggestions')
        .eq('key', `prompt_suggestions_${agentId}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error('[SupervisorService] Error getting existing prompt suggestions:', error);
        return [];
      }

      if (!memory || !memory.data) {
        return [];
      }

      return memory.data.suggestions || [];
    } catch (error: any) {
      console.error('[SupervisorService] Error getting existing prompt suggestions:', error);
      return [];
    }
  }

protected async saveNewSuggestionsToMemory(
    command: DbCommand,
    analysis: SupervisorAnalysis
  ): Promise<void> {
    console.log(`[SupervisorService] ============================================`);
    console.log(`[SupervisorService] SAVING SUGGESTIONS TO MEMORY`);
    console.log(`[SupervisorService] Tool suggestions: ${analysis.system_suggested_tools_for_development.length}`);
    console.log(`[SupervisorService] Prompt suggestions: ${analysis.prompt_suggestions.length}`);
    console.log(`[SupervisorService] ============================================`);

    try {
      // Save tool suggestions to system memory (append)
      if (analysis.system_suggested_tools_for_development.length > 0) {
        console.log(`[SupervisorService] 🔧 ATTEMPTING TO SAVE ${analysis.system_suggested_tools_for_development.length} TOOL SUGGESTIONS TO SYSTEM MEMORY`);
        console.log(`[SupervisorService] Command ID: ${command.id}`);
        console.log(`[SupervisorService] Tool suggestions details:`, JSON.stringify(analysis.system_suggested_tools_for_development, null, 2));

        try {
          await this.appendToolSuggestionsToSystemMemory(command.id, analysis.system_suggested_tools_for_development, command.site_id);
          console.log(`[SupervisorService] ✅ SUCCESSFULLY SAVED TOOL SUGGESTIONS TO SYSTEM MEMORY`);
        } catch (toolError: any) {
          console.error(`[SupervisorService] ❌ CRITICAL ERROR SAVING TOOL SUGGESTIONS:`, toolError);
          console.error(`[SupervisorService] Error message:`, toolError.message);
          console.error(`[SupervisorService] Error stack:`, toolError.stack);
          throw toolError; // Re-throw to see the error
        }
      } else {
        console.log(`[SupervisorService] ⚠️ NO TOOL SUGGESTIONS TO SAVE (filtered out as duplicates or empty)`);
      }

      // Save prompt suggestions to agent memory (append)
      if (analysis.prompt_suggestions.length > 0 && command.agent_id) {
        console.log(`[SupervisorService] 📝 ATTEMPTING TO SAVE ${analysis.prompt_suggestions.length} PROMPT SUGGESTIONS TO AGENT MEMORY`);
        console.log(`[SupervisorService] Agent ID: ${command.agent_id}, User ID: ${command.user_id}`);

        try {
          await this.appendPromptSuggestionsToAgentMemory(
            command.agent_id,
            command.user_id,
            command.id,
            analysis.prompt_suggestions
          );
          console.log(`[SupervisorService] ✅ SUCCESSFULLY SAVED PROMPT SUGGESTIONS TO AGENT MEMORY`);
        } catch (promptError: any) {
          console.error(`[SupervisorService] ❌ CRITICAL ERROR SAVING PROMPT SUGGESTIONS:`, promptError);
          console.error(`[SupervisorService] Error message:`, promptError.message);
          console.error(`[SupervisorService] Error stack:`, promptError.stack);
          throw promptError; // Re-throw to see the error
        }
      } else {
        console.log(`[SupervisorService] ⚠️ NO PROMPT SUGGESTIONS TO SAVE ${!command.agent_id ? '(no agent_id)' : '(filtered out as duplicates or empty)'}`);
      }

      console.log(`[SupervisorService] ============================================`);
      console.log(`[SupervisorService] FINISHED SAVING SUGGESTIONS TO MEMORY`);
      console.log(`[SupervisorService] ============================================`);
    } catch (error: any) {
      console.error('[SupervisorService] ❌❌❌ FATAL ERROR IN saveNewSuggestionsToMemory:', error);
      console.error('[SupervisorService] Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      // Don't throw - log the error prominently but don't break the flow
    }
  }

protected async appendToolSuggestionsToSystemMemory(
    commandId: string,
    toolSuggestions: SupervisorAnalysis['system_suggested_tools_for_development'],
    siteId?: string
  ): Promise<void> {
    try {
      const systemMemoryService = new SystemMemoryService();
      const now = new Date().toISOString();

      console.log(`[SupervisorService] Starting to append ${toolSuggestions.length} tool suggestions to system memory`);

      // Prepare new suggestions with metadata
      const newSuggestions = toolSuggestions.map(suggestion => ({
        ...suggestion,
        created_at: now,
        command_id: commandId,
        status: 'pending' // Human-readable status for manual editing
      }));

      // Find existing memory
      console.log(`[SupervisorService] Searching for existing tool suggestions memory...`);
      const memoryResult = await systemMemoryService.findMemoriesGlobal(
        'supervisor_tool_suggestions',
        'tool_suggestions'
      );

      console.log(`[SupervisorService] Memory search result:`, {
        success: memoryResult.success,
        memoriesFound: memoryResult.memories?.length || 0,
        error: memoryResult.error
      });

      // Use site_id from existing memory, or from command, or fail
      let effectiveSiteId: string | undefined;

      if (memoryResult.success && memoryResult.memories && memoryResult.memories.length > 0) {
        // Append to existing memory - use the site_id from the existing memory
        const existingMemory = memoryResult.memories[0];
        effectiveSiteId = existingMemory.siteId;
        const existingSuggestions = existingMemory.data?.suggestions || [];
        const updatedSuggestions = [...existingSuggestions, ...newSuggestions];

        console.log(`[SupervisorService] Updating existing memory. Previous: ${existingSuggestions.length}, New: ${newSuggestions.length}, Total: ${updatedSuggestions.length}`);
        console.log(`[SupervisorService] Using site_id from existing memory: ${effectiveSiteId}`);

        const updateResult = await systemMemoryService.updateMemory(
          {
            siteId: effectiveSiteId,
            systemType: 'supervisor_tool_suggestions',
            key: 'tool_suggestions'
          },
          {
            data: {
              suggestions: updatedSuggestions,
              last_updated: now,
              total_suggestions: updatedSuggestions.length
            }
          }
        );

        console.log(`[SupervisorService] Update result:`, updateResult);
      } else {
        // Create new memory - use site_id from command
        if (!siteId) {
          throw new Error('Cannot create system memory: site_id is required but not provided');
        }

        effectiveSiteId = siteId;
        console.log(`[SupervisorService] Creating new system memory for tool suggestions`);
        console.log(`[SupervisorService] Using site_id from command: ${effectiveSiteId}`);

        const createResult = await systemMemoryService.createMemory({
          siteId: effectiveSiteId,
          systemType: 'supervisor_tool_suggestions',
          key: 'tool_suggestions',
          data: {
            suggestions: newSuggestions,
            last_updated: now,
            total_suggestions: newSuggestions.length
          },
          metadata: {
            purpose: 'prevent_duplicate_tool_suggestions',
            scope: 'global',
            human_readable: true
          },
          commandId: commandId
        });

        console.log(`[SupervisorService] Create result:`, createResult);
      }

      console.log(`[SupervisorService] Successfully appended ${newSuggestions.length} tool suggestions to system memory`);
    } catch (error: any) {
      console.error('[SupervisorService] Error appending tool suggestions to system memory:', error);
      console.error('[SupervisorService] Error stack:', error.stack);
      throw error; // Re-throw to be caught by caller
    }
  }

protected async appendPromptSuggestionsToAgentMemory(
    agentId: string,
    userId: string,
    commandId: string,
    promptSuggestions: SupervisorAnalysis['prompt_suggestions']
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const memoryKey = `prompt_suggestions_${agentId}`;

      // Prepare new suggestions with metadata
      const newSuggestions = promptSuggestions.map(suggestion => ({
        ...suggestion,
        created_at: now,
        command_id: commandId
      }));

      // Find existing memory
      const { data: existingMemory, error: findError } = await supabaseAdmin
        .from('agent_memories')
        .select('*')
        .eq('agent_id', agentId)
        .eq('user_id', userId)
        .eq('type', 'supervisor_prompt_suggestions')
        .eq('key', memoryKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingMemory) {
        // Append to existing memory
        const existingSuggestions = existingMemory.data?.suggestions || [];
        const updatedSuggestions = [...existingSuggestions, ...newSuggestions];

        const { error: updateError } = await supabaseAdmin
          .from('agent_memories')
          .update({
            data: {
              ...existingMemory.data,
              suggestions: updatedSuggestions,
              last_updated: now,
              total_suggestions: updatedSuggestions.length
            },
            updated_at: now,
            last_accessed: now,
            access_count: (existingMemory.access_count || 0) + 1
          })
          .eq('id', existingMemory.id);

        if (updateError) {
          console.error('[SupervisorService] Error updating agent prompt memory:', updateError);
        } else {
          console.log(`[SupervisorService] Appended ${newSuggestions.length} prompt suggestions to agent memory`);
        }
      } else {
        // Create new memory
        const memoryId = uuidv4();
        const { error: insertError } = await supabaseAdmin
          .from('agent_memories')
          .insert({
            id: memoryId,
            agent_id: agentId,
            user_id: userId,
            type: 'supervisor_prompt_suggestions',
            key: memoryKey,
            data: {
              suggestions: newSuggestions,
              last_updated: now,
              total_suggestions: newSuggestions.length
            },
            metadata: {
              purpose: 'prevent_duplicate_prompt_suggestions',
              scope: 'agent_specific'
            },
            created_at: now,
            updated_at: now,
            access_count: 0,
            last_accessed: now
          });

        if (insertError) {
          console.error('[SupervisorService] Error creating agent prompt memory:', insertError);
        } else {
          console.log(`[SupervisorService] Created agent prompt memory for agent ${agentId}`);
        }
      }
    } catch (error: any) {
      console.error('[SupervisorService] Error appending prompt suggestions to agent memory:', error);
    }
  }
}
