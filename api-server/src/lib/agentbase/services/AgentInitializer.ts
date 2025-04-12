/**
 * AgentInitializer - Inicializa agentes y configura event listeners para Agentbase
 */
import { CommandService } from './CommandService';
import { PortkeyAgentConnector } from './PortkeyAgentConnector';
import { PortkeyAgent } from '../agents/PortkeyAgent';
import { ToolEvaluatorAgent } from '../agents/ToolEvaluatorAgent';
import { TargetProcessorAgent } from '../agents/TargetProcessorAgent';
import { PortkeyConfig, PortkeyModelOptions, DbCommand } from '../models/types';
import { BaseAgent } from '../agents/BaseAgent';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';

// Singleton para la inicialización de los agentes
class AgentInitializer {
  private static instance: AgentInitializer;
  private initialized: boolean = false;
  private commandService: CommandService;
  private agents: Record<string, BaseAgent> = {};
  
  // Constructor privado para el patrón singleton
  private constructor() {
    this.commandService = new CommandService();
    console.log('🔧 AgentInitializer: Inicializando servicio de comandos');
  }
  
  // Obtener la instancia única
  public static getInstance(): AgentInitializer {
    if (!AgentInitializer.instance) {
      AgentInitializer.instance = new AgentInitializer();
    }
    return AgentInitializer.instance;
  }
  
  // Inicializar los agentes y configurar los event listeners
  public initialize() {
    if (this.initialized) {
      console.log('🔍 AgentInitializer: Ya inicializado, omitiendo');
      return;
    }
    
    console.log('🚀 AgentInitializer: Inicializando agentes y listeners');
    
    // Configurar Portkey
    const portkeyConfig: PortkeyConfig = {
      apiKey: process.env.PORTKEY_API_KEY || '',
      virtualKeys: {
        'anthropic': process.env.ANTHROPIC_API_KEY || '',
        'openai': process.env.AZURE_OPENAI_API_KEY || '',
        'gemini': process.env.GEMINI_API_KEY || ''
      },
      baseURL: 'https://api.portkey.ai/v1'
    };
    
    // Crear conector para LLMs
    const connector = new PortkeyAgentConnector(portkeyConfig, {
      modelType: 'openai',
      modelId: 'gpt-4o',
      maxTokens: 4096,
      temperature: 0.7
    });
    
    // Crear agentes
    // 1. Agente principal para soporte al cliente
    this.agents['default_customer_support_agent'] = new PortkeyAgent(
      'default_customer_support_agent',
      'Customer Support Agent',
      connector,
      ['customer_support', 'order_tracking', 'issue_resolution']
    );
    
    // 2. Agente para evaluar herramientas
    this.agents['tool_evaluator'] = new ToolEvaluatorAgent(
      'tool_evaluator',
      'Tool Evaluator Agent',
      connector,
      ['tool_evaluation'],
      {
        modelType: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 1000,
        temperature: 0
      }
    );
    
    // 3. Agente para procesar targets
    this.agents['target_processor'] = new TargetProcessorAgent(
      'target_processor',
      'Target Processor Agent',
      connector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 2000,
        temperature: 0.2
      }
    );
    
    // Configurar event listeners
    this.setupEventListeners();
    
    this.initialized = true;
    console.log('✅ AgentInitializer: Inicialización completada');
  }
  
  // Configurar los event listeners para procesar comandos
  private setupEventListeners() {
    // Listener para el evento commandCreated
    this.commandService.on('commandCreated', async (command: DbCommand) => {
      console.log(`📥 Comando creado: ${command.id}, agente: ${command.agent_id}`);
      
      try {
        // Extraer el UUID de la base de datos si está disponible en los metadatos
        const dbUuid = command.metadata?.dbUuid || command.id;
        console.log(`🔍 UUID para actualizaciones: ${dbUuid}`);
        
        // Actualizar estado a 'running'
        await this.commandService.updateStatus(command.id, 'running');
        
        // PASO 1: Evaluar herramientas primero si hay tools definidas
        if (command.tools && command.tools.length > 0) {
          console.log(`🔍 Evaluando herramientas para el comando: ${command.id}`);
          
          // Crear una copia del comando para la evaluación de herramientas
          const toolEvalCommand = {
            ...command,
            agent_id: 'tool_evaluator' // Asignar al evaluador de herramientas
          };
          
          // Ejecutar la evaluación de herramientas
          const toolEvalResult = await this.agents['tool_evaluator'].executeCommand(toolEvalCommand);
          
          if (toolEvalResult.status === 'failed') {
            throw new Error(`Tool evaluation failed: ${toolEvalResult.error}`);
          }
          
          // Actualizar el comando con los resultados de la evaluación
          const updatedCommand = {
            ...command,
            results: toolEvalResult.results
          };
          
          // Si el resultado de la evaluación contiene un comando actualizado, usarlo
          // para actualizar también las herramientas
          if (toolEvalResult.updatedCommand) {
            console.log(`🔄 El evaluador de herramientas devolvió un comando actualizado con ${toolEvalResult.updatedCommand.tools?.length || 0} herramientas`);
            
            // Usar las herramientas actualizadas
            if (toolEvalResult.updatedCommand.tools && toolEvalResult.updatedCommand.tools.length > 0) {
              updatedCommand.tools = toolEvalResult.updatedCommand.tools;
            }
            
            // Actualizar los contadores de tokens si están disponibles
            if (toolEvalResult.updatedCommand?.input_tokens !== undefined) {
              updatedCommand.input_tokens = Number(command.input_tokens || 0) + Number(toolEvalResult.updatedCommand.input_tokens);
              console.log(`🔢 Tokens de entrada acumulados: ${updatedCommand.input_tokens}`);
            }
            
            if (toolEvalResult.updatedCommand?.output_tokens !== undefined) {
              updatedCommand.output_tokens = Number(command.output_tokens || 0) + Number(toolEvalResult.updatedCommand.output_tokens);
              console.log(`🔢 Tokens de salida acumulados: ${updatedCommand.output_tokens}`);
            }
          }
          
          // Actualizar en la base de datos usando UUID si es válido
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            console.log(`🔄 Actualizando resultados y herramientas en BD con UUID: ${dbUuid}`);
            await DatabaseAdapter.updateCommand(dbUuid, {
              results: toolEvalResult.results,
              tools: updatedCommand.tools,
              input_tokens: updatedCommand.input_tokens,
              output_tokens: updatedCommand.output_tokens
            });
          } else {
            console.log(`🔄 Actualizando resultados y herramientas con ID: ${command.id}`);
            await this.commandService.updateCommand(command.id, {
              results: toolEvalResult.results,
              tools: updatedCommand.tools,
              input_tokens: updatedCommand.input_tokens,
              output_tokens: updatedCommand.output_tokens
            });
          }
          
          console.log(`✅ Evaluación de herramientas completada para: ${command.id}`);
          
          // Actualizar el comando para el siguiente paso
          command = updatedCommand;
        }
        
        // PASO 2: Procesar targets
        if (command.targets && command.targets.length > 0) {
          console.log(`🎯 Procesando targets para el comando: ${command.id}`);
          
          // Crear una copia del comando para el procesamiento de targets
          const targetProcessCommand = {
            ...command,
            agent_id: 'target_processor' // Asignar al procesador de targets
          };
          
          // Ejecutar el procesamiento de targets
          const targetProcessResult = await this.agents['target_processor'].executeCommand(targetProcessCommand);
          
          if (targetProcessResult.status === 'failed') {
            throw new Error(`Target processing failed: ${targetProcessResult.error}`);
          }
          
          // Actualizar el comando con los resultados del procesamiento
          const finalResults = targetProcessResult.results;
          
          // Acumular tokens si están disponibles en el resultado
          let updatedInputTokens = Number(command.input_tokens || 0);
          let updatedOutputTokens = Number(command.output_tokens || 0);
          
          if (targetProcessResult.updatedCommand) {
            if (targetProcessResult.updatedCommand.input_tokens !== undefined) {
              // Usar los tokens ya acumulados en lugar de sumarlos nuevamente
              updatedInputTokens = Number(targetProcessResult.updatedCommand.input_tokens);
              console.log(`🔢 Tokens de entrada del procesador de targets: ${updatedInputTokens}`);
            }
            
            if (targetProcessResult.updatedCommand.output_tokens !== undefined) {
              // Usar los tokens ya acumulados en lugar de sumarlos nuevamente
              updatedOutputTokens = Number(targetProcessResult.updatedCommand.output_tokens);
              console.log(`🔢 Tokens de salida del procesador de targets: ${updatedOutputTokens}`);
            }
          }
          
          // Actualizar en la base de datos
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            console.log(`🔄 Actualizando resultados de targets en BD con UUID: ${dbUuid}`);
            await DatabaseAdapter.updateCommand(dbUuid, {
              status: 'completed',
              results: finalResults,
              input_tokens: updatedInputTokens,
              output_tokens: updatedOutputTokens
            });
          } else {
            console.log(`🔄 Actualizando resultados de targets con ID: ${command.id}`);
            await this.commandService.updateCommand(command.id, {
              status: 'completed',
              results: finalResults,
              input_tokens: updatedInputTokens,
              output_tokens: updatedOutputTokens
            });
          }
          
          console.log(`✅ Procesamiento de targets completado para: ${command.id}`);
        }
        // Si no hay targets, ejecutar el flujo normal con el agente especificado
        else {
          // Seleccionar el agente correcto para ejecutar el comando
          const agentId = command.agent_id || 'default_customer_support_agent';
          const agent = this.agents[agentId];
          
          if (!agent) {
            console.error(`❌ Error: No se encontró el agente '${agentId}'`);
            await this.commandService.updateStatus(command.id, 'failed');
            return;
          }
          
          console.log(`🤖 Ejecutando comando con el agente: ${agentId}`);
          
          // Ejecutar el comando
          const result = await agent.executeCommand(command);
          
          // Acumular tokens si están disponibles en el resultado
          let updatedInputTokens = Number(command.input_tokens || 0);
          let updatedOutputTokens = Number(command.output_tokens || 0);
          
          if (result.updatedCommand) {
            if (result.updatedCommand.input_tokens !== undefined) {
              updatedInputTokens += Number(result.updatedCommand.input_tokens);
              console.log(`🔢 Tokens de entrada acumulados en ejecución directa: ${updatedInputTokens}`);
            }
            
            if (result.updatedCommand.output_tokens !== undefined) {
              updatedOutputTokens += Number(result.updatedCommand.output_tokens);
              console.log(`🔢 Tokens de salida acumulados en ejecución directa: ${updatedOutputTokens}`);
            }
          }
          
          // Actualizar el comando con los resultados
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            console.log(`🔄 Actualizando resultados del agente en BD con UUID: ${dbUuid}`);
            await DatabaseAdapter.updateCommand(dbUuid, {
              status: result.status,
              results: result.results,
              input_tokens: updatedInputTokens,
              output_tokens: updatedOutputTokens
            });
          } else {
            console.log(`🔄 Actualizando resultados del agente con ID: ${command.id}`);
            await this.commandService.updateCommand(command.id, {
              status: result.status,
              results: result.results,
              input_tokens: updatedInputTokens,
              output_tokens: updatedOutputTokens
            });
          }
          
          // Si hay un error, almacenarlo en el contexto
          if (result.error) {
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, {
                context: `Error: ${result.error}\n${command.context || ''}`
              });
            } else {
              await this.commandService.updateCommand(command.id, {
                context: `Error: ${result.error}\n${command.context || ''}`
              });
            }
          }
          
          console.log(`✅ Comando ${command.id} completado con estado: ${result.status}`);
        }
      } catch (error: any) {
        console.error(`❌ Error procesando comando ${command.id}:`, error);
        
        // Extraer el UUID si no lo tenemos ya
        const errorDbUuid = command.metadata?.dbUuid || command.id;
        
        // Actualizar el comando con el error en el contexto
        if (errorDbUuid && DatabaseAdapter.isValidUUID(errorDbUuid)) {
          console.log(`🔄 Registrando error en BD con UUID: ${errorDbUuid}`);
          await DatabaseAdapter.updateCommand(errorDbUuid, {
            status: 'failed',
            context: `Error de ejecución: ${error.message || 'Error desconocido'}\n${command.context || ''}`
          });
        } else {
          console.log(`🔄 Registrando error con ID: ${command.id}`);
          await this.commandService.updateCommand(command.id, {
            status: 'failed',
            context: `Error de ejecución: ${error.message || 'Error desconocido'}\n${command.context || ''}`
          });
        }
      }
    });
    
    // Listener para cambios de estado
    this.commandService.on('statusChange', (update: { id: string, dbId?: string, status: string }) => {
      console.log(`🔄 Comando ${update.id} cambió a estado: ${update.status}${update.dbId ? `, UUID: ${update.dbId}` : ''}`);
    });
    
    console.log('🔊 Event listeners configurados');
  }
  
  // Obtener el servicio de comandos
  public getCommandService(): CommandService {
    return this.commandService;
  }
}

export default AgentInitializer;