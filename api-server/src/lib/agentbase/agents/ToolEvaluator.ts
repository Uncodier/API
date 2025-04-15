/**
 * ToolEvaluator - Procesador especializado para evaluar qué herramientas
 * deben activarse basado en el mensaje del usuario.
 */
import { Base } from './Base';
import { PortkeyConnector } from '../services/PortkeyConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions, ToolExecutionResult } from '../models/types';
import { TOOL_EVALUATOR_SYSTEM_PROMPT, formatToolEvaluatorPrompt } from '../prompts/tool-evaluator-prompt';

// Interfaces para el nuevo formato de respuesta
interface ToolFunctionCall {
  reasoning: string;
  type: "function_call";
  name: string;
  arguments: string;
}

interface ToolExclusion {
  reasoning: string;
  type: "exclusion";
  name: string;
}

type ToolDecision = ToolFunctionCall | ToolExclusion;

export class ToolEvaluator extends Base {
  private connector: PortkeyConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;
  // Propiedades adicionales del agente
  readonly description?: string;
  readonly systemPrompt?: string;

  constructor(
    id: string, 
    name: string, 
    connector: PortkeyConnector,
    capabilities: string[] = ['tool_evaluation'],
    defaultOptions?: Partial<PortkeyModelOptions>,
    description?: string,
    systemPrompt?: string
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {};
    this.description = description;
    this.systemPrompt = systemPrompt;
    
    // Loguear para depuración
    if (this.description) console.log(`📝 [ToolEvaluator] Descripción: ${this.description.substring(0, 100)}...`);
    if (this.systemPrompt) console.log(`🧠 [ToolEvaluator] System Prompt: ${this.systemPrompt.substring(0, 100)}...`);
  }

  /**
   * Execute command by evaluating tools based on user message
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      console.log(`[ToolEvaluator] Evaluating tools for command: ${command.id}`);
      
      // Check if there are tools to evaluate
      if (!command.tools || command.tools.length === 0) {
        console.log(`[ToolEvaluator] No tools to evaluate`);
        return {
          status: 'completed',
          results: []
        };
      }
      
      // Log tool count for debugging
      console.log(`[ToolEvaluator] Evaluating ${command.tools.length} tools`);
      
      // Prepare messages for evaluation
      const messages = this.prepareMessagesFromCommand(command);
      
      // Configure model options
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType || 'openai',
        modelId: command.model_id || this.defaultOptions.modelId || 'gpt-4o',
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 1000,
        temperature: command.temperature || this.defaultOptions.temperature || 0,
        responseFormat: 'json'
      };
      
      console.log(`[ToolEvaluator] Sending evaluation to LLM`);
      
      // Call LLM for evaluation
      const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
      
      // Extract token usage
      const portkeyUsage = this.extractTokenUsage(portkeyResponse);
      console.log(`[ToolEvaluator] Token usage - Input: ${portkeyUsage.inputTokens}, Output: ${portkeyUsage.outputTokens}`);
      
      // Extract response content
      const response = typeof portkeyResponse === 'object' && portkeyResponse.content 
        ? portkeyResponse.content 
        : portkeyResponse;
      
      console.log(`[ToolEvaluator] Response received: ${JSON.stringify(response).substring(0, 200)}...`);
      
      // Process the evaluation response
      const toolDecisions = this.processToolEvaluationResponse(response, command.tools);
      
      // Update tool status based on decisions
      const updatedTools = this.updateToolsStatus(command.tools, toolDecisions);
      
      // Return results with updated tools
      return {
        status: 'completed',
        results: [{
          type: 'tool_evaluation',
          content: {
            message: "Tool evaluation completed",
            updated_tools: updatedTools
          }
        }],
        inputTokens: portkeyUsage.inputTokens,
        outputTokens: portkeyUsage.outputTokens
      };
    } catch (error: any) {
      console.error(`[ToolEvaluator] Error evaluating tools: ${error.message}`);
      return {
        status: 'failed',
        error: `Tool evaluation failed: ${error.message}`
      };
    }
  }

  /**
   * Update tool status based on evaluation decisions
   */
  private updateToolsStatus(tools: any[], decisions: ToolDecision[]): any[] {
    const updatedTools = [...tools];
    
    // Create a map of decisions by tool name for easier lookup
    const decisionMap = new Map<string, ToolDecision>();
    decisions.forEach(decision => {
      decisionMap.set(decision.name, decision);
    });
    
    // Update each tool based on decisions
    for (const tool of updatedTools) {
      const decision = decisionMap.get(tool.name);
      
      if (decision) {
        if (decision.type === 'function_call') {
          // Tool should be used
          tool.status = 'ready';
          
          // If parameters are provided as a string, parse them to object
          try {
            const params = typeof decision.arguments === 'string' 
              ? JSON.parse(decision.arguments)
              : decision.arguments;
            
            // Assign parameters to the tool
            tool.parameters_values = params;
          } catch (e) {
            console.warn(`[ToolEvaluator] Error parsing parameters for tool ${tool.name}: ${e}`);
            tool.status = 'skipped';
            tool.skip_reason = `Error parsing parameters: ${e}`;
          }
          
          // Add reasoning if available
          if (decision.reasoning) {
            tool.activation_reason = decision.reasoning;
          }
        } else {
          // Tool should not be used
          tool.status = 'skipped';
          
          // Add reasoning if available
          if (decision.reasoning) {
            tool.skip_reason = decision.reasoning;
          } else {
            tool.skip_reason = "Not needed for this request";
          }
        }
      } else {
        // No decision found, skip by default
        tool.status = 'skipped';
        tool.skip_reason = "Not evaluated";
      }
    }
    
    return updatedTools;
  }

  /**
   * Process tool evaluation response
   */
  private processToolEvaluationResponse(response: any, tools: any[]): ToolDecision[] {
    let toolDecisions: ToolDecision[] = [];

    try {
      // Try to parse response as JSON
      if (typeof response === 'string') {
        try {
          response = JSON.parse(response);
        } catch (e) {
          // If not valid JSON, try to extract JSON blocks
          const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || 
                           response.match(/\{[\s\S]*\}/);
          
          if (jsonMatch) {
            response = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          }
        }
      }

      // Validate that response is an array
      if (response && Array.isArray(response)) {
        toolDecisions = response as ToolDecision[];
      } else {
        console.warn('[ToolEvaluator] Unexpected response format:', response);
        // If response is in old format, convert to new format
        if (response && response.tool_decisions && Array.isArray(response.tool_decisions)) {
          toolDecisions = response.tool_decisions.map((decision: any) => {
            if (decision.should_use) {
              return {
                reasoning: decision.reasoning || "Tool should be used based on user request",
                type: "function_call" as const,
                name: decision.tool_name,
                arguments: JSON.stringify(decision.parameters || {})
              };
            } else {
              return {
                reasoning: decision.reasoning || "Tool should not be used based on user request",
                type: "exclusion" as const,
                name: decision.tool_name
              };
            }
          }).filter((decision: any) => decision !== null);
        } else {
          // If no recognizable format, return empty array
          toolDecisions = [];
        }
      }
    } catch (error) {
      console.error(`[ToolEvaluator] Error processing evaluation response: ${error}`);
      toolDecisions = [];
    }

    // Verify that all tools are covered in decisions
    const toolNames = tools.map(tool => tool.name);
    const decisionNames = toolDecisions.map(decision => decision.name);
    
    // Add missing tools as "exclusion" decisions
    const missingTools = toolNames.filter(name => !decisionNames.includes(name));
    
    if (missingTools.length > 0) {
      console.log(`[ToolEvaluator] Adding default exclusions for ${missingTools.length} tools not covered in decisions`);
      
      for (const toolName of missingTools) {
        toolDecisions.push({
          reasoning: "Tool was not selected for evaluation",
          type: "exclusion",
          name: toolName
        });
      }
    }

    return toolDecisions;
  }

  /**
   * Prepare messages from the command
   */
  private prepareMessagesFromCommand(command: DbCommand): Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> {
    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = [];

    // Prioridad: 1. agent_background del comando, 2. systemPrompt del agente, 3. prompt por defecto
    if (command.agent_background) {
      console.log(`[ToolEvaluator] Usando agent_background del comando`);
      messages.push({
        role: 'system',
        content: command.agent_background
      });
    } else if (this.systemPrompt) {
      console.log(`[ToolEvaluator] Usando systemPrompt específico del agente`);
      messages.push({
        role: 'system',
        content: this.systemPrompt
      });
    } else {
      // Use default prompt if no background provided
      console.log(`[ToolEvaluator] Usando prompt por defecto al no encontrar información específica del agente`);
      messages.push({
        role: 'system',
        content: TOOL_EVALUATOR_SYSTEM_PROMPT
      });
    }

    // Add the tool evaluation prompt
    const userContext = typeof command.context === 'string'
      ? command.context
      : typeof command.context === 'object' && command.context !== null
        ? JSON.stringify(command.context)
        : '';
    
    const tools = command.tools || [];
    
    messages.push({
      role: 'user',
      content: formatToolEvaluatorPrompt(userContext, tools)
    });

    return messages;
  }
}