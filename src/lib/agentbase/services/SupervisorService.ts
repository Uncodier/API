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
import { SupervisorQueue } from './SupervisorQueue';
import { withCommandRouting } from './command/command-routing';
export type { SupervisorAnalysis, SupervisorResult } from './SupervisorTypes';

export class SupervisorService extends SupervisorQueue {
  async analyzeCommand(command: DbCommand, conversationId?: string): Promise<SupervisorResult> {
    return withCommandRouting(command, () => this.analyzeRoutedCommand(command, conversationId), 'supervise');
  }

private async analyzeRoutedCommand(command: DbCommand, conversationId?: string): Promise<SupervisorResult> {
    const startTime = Date.now();
    let supervisorCommandId: string | undefined = undefined;
    
    try {
      console.log(`[SupervisorService] Analyzing command: ${command.id}`);

      // Create a command to track the supervisor analysis using CommandService
      // Create supervisor-specific targets that represent the expected output structure
      // errata is placed at the end for better inference
      const supervisorTargets = [
        {
          analysis: {
            summary: '',
            tools_available_count: 0,
            tools_executed_count: 0,
            errors_detected: []
          },
          system_suggested_tools_for_development: [],
          prompt_suggestions: [],
          errata: []
        }
      ];

      // Extract tools from original command so they can be re-executed if needed
      // Pass the complete original command in context so supervisor can evaluate it
      // Create supervisor command using CommandFactory (for execution through agentbase)
      // Extract available tools and executed tools for context
      const availableTools = command.tools || [];
      const executedTools = this.extractExecutedTools(command.results || []);
      const commandResults = command.results || [];

      // Retrieve system memory and agent memory for context
      console.log('[SupervisorService] Retrieving system memory and agent memory...');
      const systemMemory = await this.getSystemMemoryForContext(command.site_id);
      const agentMemory = await this.getAgentMemoryForContext(command.agent_id, command.user_id);

      // Get existing tool suggestions count for critical warning
      const existingToolSuggestions = await this.getExistingToolSuggestions();
      const existingToolSuggestionsCount = existingToolSuggestions.length;

      // Format context with command details and format prompt information
      const userPrompt = formatSupervisorPrompt(
        command,
        availableTools,
        executedTools,
        commandResults,
        systemMemory,
        agentMemory,
        existingToolSuggestionsCount
      );

      const supervisorCommand = CommandFactory.createCommand({
        task: 'supervisor_analysis',
        userId: command.user_id,
        description: `Supervisor analysis for command ${command.id}`,
        agentId: command.agent_id,
        agentRole: command.agent_role,
        site_id: command.site_id,
        targets: supervisorTargets,
        tools: command.tools || [],
        context: userPrompt, // Use formatted prompt as context
        systemPrompt: SUPERVISOR_SYSTEM_PROMPT, // Set supervisor system prompt
        model: getOpenRouterChatModel(),
        modelType: 'openrouter',
        reasoningEffort: 'high',
        verbosity: 'medium',
        responseFormat: 'json'
      });

      // Submit command for execution through agentbase
      console.log(`[SupervisorService] Submitting supervisor command for execution...`);
      try {
        const submittedId = await this.commandService.submitCommand(supervisorCommand);
        if (!submittedId) {
          throw new Error('submitCommand returned null or undefined');
        }
        supervisorCommandId = submittedId;
        console.log(`[SupervisorService] Supervisor command submitted with ID: ${supervisorCommandId}`);
      } catch (submitError: any) {
        console.error('[SupervisorService] Error submitting supervisor command:', submitError);
        return {
          success: false,
          error: `Failed to submit supervisor command: ${submitError.message || 'Unknown error'}`,
          analyzed_command_id: command.id
        };
      }

      // Wait for command completion
      if (!supervisorCommandId) {
        throw new Error('Supervisor command ID is undefined after submission');
      }

      console.log(`[SupervisorService] Waiting for supervisor command to complete...`);
      const { command: executedCommand, dbUuid, completed } = await this.waitForCommandCompletion(supervisorCommandId);
      
      // Use database UUID if available, otherwise fall back to internal ID
      const finalCommandId = (dbUuid && this.isValidUUID(dbUuid)) ? dbUuid : supervisorCommandId;

      if (!completed || !executedCommand) {
        console.error('[SupervisorService] Supervisor command did not complete successfully');
        return {
          success: false,
          error: 'Supervisor command execution failed or timed out',
          analyzed_command_id: command.id,
          command_id: finalCommandId || undefined
        };
      }

      // Extract analysis from command results
      // Handle multiple result structures and transform to expected format
      let analysis: SupervisorAnalysis;
      try {
        if (!executedCommand.results || !Array.isArray(executedCommand.results) || executedCommand.results.length === 0) {
          throw new Error('No results found in executed command');
        }

        console.log(`[SupervisorService] Extracting analysis from ${executedCommand.results.length} result(s)`);

        // Search through all results to find the analysis structure
        let rawResult: any = null;
        for (const result of executedCommand.results) {
          // Check if result has analysis structure directly
          if (result.analysis && result.errata) {
            rawResult = result;
            console.log('[SupervisorService] Found analysis structure in result directly');
            break;
          }
          
          // Check if result is a string that needs parsing
          if (typeof result === 'string') {
            try {
              const parsed = JSON.parse(result);
              if (parsed.analysis && parsed.errata) {
                rawResult = parsed;
                console.log('[SupervisorService] Found analysis structure in parsed string result');
                break;
              }
            } catch (e) {
              // Not JSON, continue
            }
          }
          
          // Check if result has content field
          if (result.content) {
            const content = typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
            if (content.analysis && content.errata) {
              rawResult = content;
              console.log('[SupervisorService] Found analysis structure in content field');
              break;
            }
          }
        }

        if (!rawResult) {
          throw new Error('Could not find analysis structure in command results');
        }

        // Transform the raw result to expected SupervisorAnalysis format
        analysis = this.transformSupervisorResult(rawResult);
        
        console.log('[SupervisorService] Successfully extracted and transformed analysis');
      } catch (parseError: any) {
        console.error('[SupervisorService] Error extracting analysis from command results:', parseError);
        console.error('[SupervisorService] Command results:', JSON.stringify(executedCommand.results, null, 2));
        throw new Error(`Failed to extract supervisor analysis from command results: ${parseError.message}`);
      }

      console.log(`[SupervisorService] Analysis complete:`, {
        errors: analysis.analysis.errors_detected.length,
        errata: analysis.errata.length,
        system_suggested_tools_for_development: analysis.system_suggested_tools_for_development.length,
        prompt_suggestions: analysis.prompt_suggestions.length
      });

      // Filter suggestions using GPT-6.1 Sol inference with memory context
      const filteredAnalysis = await this.filterSuggestionsWithGPT52(command, analysis);

      console.log(`[SupervisorService] After filtering:`, {
        system_suggested_tools_for_development: filteredAnalysis.system_suggested_tools_for_development.length,
        prompt_suggestions: filteredAnalysis.prompt_suggestions.length
      });

      // Apply automated actions
      const errataApplied = await this.applyErrata(command, filteredAnalysis.errata, conversationId);
      const emailsSent = await this.sendNotifications(command, filteredAnalysis);
      
      // Save suggestions that were SENT (filtered ones) to memory
      // This ensures what we save matches what was emailed
      console.log(`[SupervisorService] About to save suggestions to memory...`);
      await this.saveNewSuggestionsToMemory(command, filteredAnalysis);
      console.log(`[SupervisorService] Finished saving suggestions to memory`);

      // Note: Command is already marked as completed by agentbase execution
      // Token usage is handled by the command execution system
      const duration = Date.now() - startTime;
      console.log(`[SupervisorService] Supervisor analysis completed in ${duration}ms`);

      // Final verification: ensure command_id exists before returning
      if (finalCommandId) {
        // Try to verify using the final command ID (UUID if available)
        const verifyId = this.isValidUUID(finalCommandId) ? finalCommandId : supervisorCommandId;
        if (verifyId) {
          const finalVerify = await this.commandService.getCommandById(verifyId);
        if (!finalVerify) {
            console.error(`[SupervisorService] WARNING: Supervisor command ${finalCommandId} not found in database before returning result`);
          // Still return success but without command_id to avoid returning a false ID
          return {
            success: true,
            analysis: filteredAnalysis,
            errata_applied: errataApplied,
            emails_sent: emailsSent,
            analyzed_command_id: command.id
            // Do not include command_id if verification fails
          };
          }
        }
      }

      return {
        success: true,
        analysis: filteredAnalysis, // Return filtered analysis
        errata_applied: errataApplied,
        emails_sent: emailsSent,
        analyzed_command_id: command.id, // The command that was analyzed (input)
        command_id: finalCommandId || undefined // The supervisor command UUID from database (or undefined if not found)
      };
    } catch (error: any) {
      console.error('[SupervisorService] Error analyzing command:', error);
      
      // Update supervisor command to failed only if it was successfully created
      if (supervisorCommandId) {
        const duration = Date.now() - startTime;
        try {
          await DatabaseAdapter.updateCommand(supervisorCommandId, {
            status: 'failed',
            // Note: error field may not exist in DbCommand type, using results to store error info
            results: [{
              type: 'error',
              error: error.message || 'Unknown error during analysis'
            }],
            duration: duration
          });
          console.log(`[SupervisorService] Updated supervisor command to failed: ${supervisorCommandId}`);
        } catch (updateError: any) {
          console.error('[SupervisorService] Error updating supervisor command status to failed:', updateError);
        }
      }

      // Try to get UUID even if command failed
      let finalCommandIdOnError: string | undefined = undefined;
      if (supervisorCommandId) {
        try {
          const errorDbUuid = await this.getCommandDbUuid(supervisorCommandId);
          if (errorDbUuid && this.isValidUUID(errorDbUuid)) {
            finalCommandIdOnError = errorDbUuid;
          } else {
            finalCommandIdOnError = supervisorCommandId;
          }
        } catch (uuidError) {
          console.error('[SupervisorService] Error getting UUID on error:', uuidError);
          finalCommandIdOnError = supervisorCommandId;
        }
      }

      return {
        success: false,
        error: error.message || 'Unknown error during analysis',
        analyzed_command_id: command.id, // The command that was analyzed (input)
        command_id: finalCommandIdOnError // The supervisor command UUID from database (or internal ID as fallback)
      };
    }
  }
}
