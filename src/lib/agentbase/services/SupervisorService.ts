/**
 * SupervisorService - Analyzes command execution to detect missing tools and suggest improvements
 */
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

export interface SupervisorAnalysis {
  analysis: {
    summary: string;
    tools_available_count: number;
    tools_executed_count: number;
    errors_detected: Array<{
      type: string;
      description: string;
      severity: 'high' | 'medium' | 'low';
    }>;
  };
  errata: Array<{
    message: string;
  }>;
  system_suggested_tools_for_development: Array<{
    tool_name: string;
    description: string;
    use_case: string;
    priority: 'high' | 'medium' | 'low';
    rationale: string;
  }>;
  prompt_suggestions: Array<{
    context: string;
    improved_prompt: string;
    rationale: string;
    example: string;
  }>;
}

export interface SupervisorResult {
  success: boolean;
  analysis?: SupervisorAnalysis;
  error?: string;
  errata_applied?: number;
  emails_sent?: number;
  analyzed_command_id?: string; // The command that was analyzed (input)
  command_id?: string; // The supervisor command created for this analysis
}

export class SupervisorService {
  private connector: PortkeyConnector;
  private sendGridService: SendGridService;
  private processorInitializer: ProcessorInitializer;
  private commandService: any;

  constructor() {
    // Initialize ProcessorInitializer to access CommandService
    this.processorInitializer = ProcessorInitializer.getInstance();
    this.processorInitializer.initialize();
    this.commandService = this.processorInitializer.getCommandService();
    // Initialize Portkey connector with GPT-5.2 configuration
    // Use same Azure configuration as other agents (ProcessorConfigurationService)
    const portkeyConfig: PortkeyConfig = {
      apiKey: process.env.PORTKEY_API_KEY || '',
      virtualKeys: {
        'anthropic': process.env.ANTHROPIC_API_KEY || '',
        'openai': process.env.AZURE_OPENAI_API_KEY || '',
        'gemini': process.env.GEMINI_API_KEY || ''
      },
      baseURL: 'https://api.portkey.ai/v1'
    };

    this.connector = new PortkeyConnector(portkeyConfig, {
      modelType: 'openai',
      modelId: 'gpt-5.2',
      maxTokens: 32768,
      temperature: 1, // GPT-5.2 uses default temperature
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

  /**
   * Validate UUID format
   */
  private isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Get database UUID from command internal ID
   */
  private async getCommandDbUuid(internalId: string): Promise<string | null> {
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

  /**
   * Wait for command completion and return UUID
   */
  private async waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000): Promise<{command: any, dbUuid: string | null, completed: boolean}> {
    let executedCommand = null;
    let attempts = 0;
    let dbUuid: string | null = null;
    
    console.log(`[SupervisorService] Waiting for command ${commandId} to complete...`);
    
    return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
      const checkInterval = setInterval(async () => {
        attempts++;
        
        try {
          executedCommand = await this.commandService.getCommandById(commandId);
          
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

  /**
   * Analyze a command to detect missing tools and suggest improvements
   * @param command The command to analyze
   * @param conversationId Optional conversation ID to use for errata messages (if not provided, will try to extract from command)
   */
  async analyzeCommand(command: DbCommand, conversationId?: string): Promise<SupervisorResult> {
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
        site_id: command.site_id,
        targets: supervisorTargets,
        tools: command.tools || [],
        context: userPrompt, // Use formatted prompt as context
        systemPrompt: SUPERVISOR_SYSTEM_PROMPT, // Set supervisor system prompt
        model: 'gpt-5.2',
        modelType: 'openai',
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

      // Filter suggestions using GPT-5.2 inference with memory context
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

  /**
   * Transform raw supervisor result to expected SupervisorAnalysis format
   * Handles different formats from the supervisor agent output
   */
  private transformSupervisorResult(rawResult: any): SupervisorAnalysis {
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

  /**
   * Extract executed tools from command results
   */
  private extractExecutedTools(results: any[]): any[] {
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

  /**
   * Apply errata to conversation
   * @param command The command being analyzed
   * @param errata Array of errata to apply
   * @param conversationId Optional conversation ID to use (if not provided, will try to extract from command)
   */
  private async applyErrata(
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

  /**
   * Send email notifications for tool and prompt suggestions
   */
  private async sendNotifications(
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

  /**
   * Extract agent information from command
   */
  private extractAgentInfo(command: DbCommand): { name: string; role?: string; capabilities?: string[] } {
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

  /**
   * Extract conversation ID from command
   */
  private extractConversationId(command: DbCommand): string | null {
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

  /**
   * Format tool suggestions email
   */
  private formatToolSuggestionsEmail(
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

  /**
   * Format prompt suggestions email
   */
  private formatPromptSuggestionsEmail(
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

  /**
   * Filter suggestions using GPT-5.2 inference with memory context
   * Retrieves existing suggestions from memory and uses GPT-5.2 to determine which new suggestions are truly unique
   */
  private async filterSuggestionsWithGPT52(
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

      // Call GPT-5.2 for similarity analysis
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

      console.log(`[SupervisorService] Calling GPT-5.2 for similarity analysis...`);
      const response = await this.connector.callAgent(messages, {
        modelType: 'openai',
        modelId: 'gpt-5.2',
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
          console.error('[SupervisorService] Error parsing GPT-5.2 similarity response:', parseError);
          // Fallback: keep all suggestions if parsing fails
          return analysis;
        }
      } else {
        similarityResult = response.content;
      }

      // Use filtered suggestions from GPT-5.2
      const filteredAnalysis = {
        ...analysis,
        system_suggested_tools_for_development: similarityResult.new_suggestions?.system_suggested_tools_for_development || [],
        prompt_suggestions: similarityResult.new_suggestions?.prompt_suggestions || []
      };

      console.log(`[SupervisorService] GPT-5.2 filtered suggestions:`, {
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

  /**
   * Get system memory for context (tool suggestions and other system memories)
   */
  private async getSystemMemoryForContext(siteId?: string): Promise<any> {
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

  /**
   * Get agent memory for context (prompt suggestions and other agent memories)
   */
  private async getAgentMemoryForContext(agentId?: string, userId?: string): Promise<any> {
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

  /**
   * Get existing tool suggestions from system memory
   */
  private async getExistingToolSuggestions(): Promise<any[]> {
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

  /**
   * Get existing prompt suggestions from agent memory
   */
  private async getExistingPromptSuggestions(agentId?: string, userId?: string): Promise<any[]> {
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

  /**
   * Save new suggestions to memory after sending (append-only approach)
   * Only saves suggestions that passed GPT-5.2 filtering (truly new ones)
   */
  private async saveNewSuggestionsToMemory(
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

  /**
   * Append tool suggestions to system memory (human-readable, append-only)
   */
  private async appendToolSuggestionsToSystemMemory(
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

  /**
   * Append prompt suggestions to agent memory (append-only)
   */
  private async appendPromptSuggestionsToAgentMemory(
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

