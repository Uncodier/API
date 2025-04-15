/**
 * ProcessorInitializer - Inicializa los procesadores y configura event listeners para Agentbase
 */
import { CommandService } from './CommandService';
import { PortkeyConnector } from './PortkeyConnector';
import { PortkeyAgent } from '../agents/PortkeyAgent';
import { ToolEvaluator } from '../agents/ToolEvaluator';
import { TargetProcessor } from '../agents/TargetProcessor';
import { PortkeyConfig, PortkeyModelOptions, DbCommand } from '../models/types';
import { Base } from '../agents/Base';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';

// Singleton para la inicialización de los procesadores
export class ProcessorInitializer {
  private static instance: ProcessorInitializer;
  private initialized: boolean = false;
  private commandService: CommandService;
  private processors: Record<string, Base> = {};
  
  // Constructor privado para el patrón singleton
  private constructor() {
    this.commandService = new CommandService();
    console.log('🔧 ProcessorInitializer: Inicializando servicio de comandos');
  }
  
  // Obtener la instancia única
  public static getInstance(): ProcessorInitializer {
    if (!ProcessorInitializer.instance) {
      ProcessorInitializer.instance = new ProcessorInitializer();
    }
    return ProcessorInitializer.instance;
  }
  
  // Inicializar los procesadores y configurar los event listeners
  public initialize() {
    if (this.initialized) {
      console.log('🔍 ProcessorInitializer: Ya inicializado, omitiendo');
      return;
    }
    
    console.log('🚀 ProcessorInitializer: Inicializando procesadores y listeners');
    
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
    const connector = new PortkeyConnector(portkeyConfig, {
      modelType: 'openai',
      modelId: 'gpt-4o',
      maxTokens: 4096,
      temperature: 0.7
    });
    
    // Crear procesadores
    // 1. Agente principal para soporte al cliente
    this.processors['default_customer_support_agent'] = new PortkeyAgent(
      'default_customer_support_agent',
      'Customer Support Agent',
      connector,
      ['customer_support', 'order_tracking', 'issue_resolution']
    );
    
    // 2. Procesador para evaluar herramientas
    this.processors['tool_evaluator'] = new ToolEvaluator(
      'tool_evaluator',
      'Tool Evaluator',
      connector,
      ['tool_evaluation'],
      {
        modelType: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 1000,
        temperature: 0
      }
    );
    
    // 3. Procesador para generar respuestas
    this.processors['target_processor'] = new TargetProcessor(
      'target_processor',
      'Target Processor',
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
    console.log('✅ ProcessorInitializer: Inicialización completada');
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
        
        // Almacenar información del agente principal en agent_background si hay un agent_id
        if (command.agent_id && this.processors[command.agent_id]) {
          const processor = this.processors[command.agent_id];
          const agentBackground = `You are ${processor.getName()} (ID: ${processor.getId()}), an AI assistant with the following capabilities: ${processor.getCapabilities().join(', ')}.`;
          
          // Actualizar el comando con la información del agente
          command = {
            ...command,
            agent_background: agentBackground
          };
          
          // Guardar esta información en la base de datos
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            await DatabaseAdapter.updateCommand(dbUuid, {
              agent_background: agentBackground
            });
          } else {
            await this.commandService.updateCommand(command.id, {
              agent_background: agentBackground
            });
          }
        }
        
        // =========================================================
        // Paso 1: Evaluar las herramientas disponibles
        // =========================================================
        if (command.tools && command.tools.length > 0) {
          console.log(`🛠️ Evaluando ${command.tools.length} herramientas para el comando: ${command.id}`);
          
          try {
            // Obtener el procesador de herramientas
            const toolEvaluator = this.processors['tool_evaluator'] as ToolEvaluator;
            
            if (!toolEvaluator) {
              throw new Error('Tool evaluator not initialized');
            }
            
            // Ejecutar la evaluación
            console.log(`🔄 Iniciando evaluación de herramientas para: ${command.id}`);
            const toolResult = await toolEvaluator.executeCommand(command);
            
            if (toolResult.status === 'completed' && toolResult.results) {
              console.log(`✅ Evaluación de herramientas completada para: ${command.id}`);
              
              // Actualizar el comando con los resultados
              if (toolResult.results.length > 0) {
                // Actualizar los resultados en la base de datos
                await this.commandService.updateResults(command.id, toolResult.results);
                
                // Actualizar las herramientas
                const evaluationResult = toolResult.results.find(r => r.type === 'tool_evaluation');
                if (evaluationResult && evaluationResult.content && evaluationResult.content.updated_tools) {
                  // Actualizar las herramientas en el comando
                  command.tools = evaluationResult.content.updated_tools;
                  
                  // Guardar las herramientas actualizadas en la base de datos
                  if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                    await DatabaseAdapter.updateCommand(dbUuid, {
                      tools: command.tools
                    });
                  }
                }
                
                // Actualizar tokens acumulados
                if (toolResult.inputTokens || toolResult.outputTokens) {
                  const inputTokens = Number(command.input_tokens || 0) + Number(toolResult.inputTokens || 0);
                  const outputTokens = Number(command.output_tokens || 0) + Number(toolResult.outputTokens || 0);
                  
                  command.input_tokens = inputTokens;
                  command.output_tokens = outputTokens;
                  
                  // Actualizar tokens en la base de datos
                  if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                    await DatabaseAdapter.updateCommand(dbUuid, {
                      input_tokens: inputTokens,
                      output_tokens: outputTokens
                    });
                  }
                  
                  console.log(`🔢 Tokens acumulados después de evaluación: input=${inputTokens}, output=${outputTokens}`);
                }
              }
            } else if (toolResult.status === 'failed') {
              console.error(`❌ Error en evaluación de herramientas: ${toolResult.error}`);
              
              // Actualizar el estado del comando a failed
              await this.commandService.updateStatus(command.id, 'failed', toolResult.error);
              return;
            }
          } catch (error: any) {
            console.error(`❌ Error al evaluar herramientas: ${error.message}`);
            
            // Actualizar el estado del comando a failed
            await this.commandService.updateStatus(command.id, 'failed', `Tool evaluation error: ${error.message}`);
            return;
          }
        }
        
        // =========================================================
        // Paso 2: Procesar los targets
        // =========================================================
        if (command.targets && command.targets.length > 0) {
          console.log(`🎯 Procesando targets para el comando: ${command.id}`);
          
          try {
            // Obtener el procesador de targets
            const targetProcessor = this.processors['target_processor'] as TargetProcessor;
            
            if (!targetProcessor) {
              throw new Error('Target processor not initialized');
            }
            
            // Ejecutar el procesamiento
            const targetResult = await targetProcessor.executeCommand(command);
            
            if (targetResult.status === 'completed' && targetResult.results) {
              console.log(`✅ Procesamiento de targets completado para: ${command.id}`);
              
              // Actualizar tokens en base de datos (input_tokens y output_tokens)
              // Siempre actualizar con valores acumulados
              const currentInputTokens = Number(command.input_tokens || 0);
              const currentOutputTokens = Number(command.output_tokens || 0);
              const inputTokens = currentInputTokens + Number(targetResult.inputTokens || 0);
              const outputTokens = currentOutputTokens + Number(targetResult.outputTokens || 0);
              
              console.log(`🔢 Tokens de entrada del procesador de targets: ${inputTokens}`);
              console.log(`🔢 Tokens de salida del procesador de targets: ${outputTokens}`);
              
              // Actualizar resultados en la base de datos
              if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                console.log(`🔄 Actualizando resultados de targets en BD con UUID: ${dbUuid}`);
                
                // Actualizar la base de datos con los resultados
                await DatabaseAdapter.updateCommand(dbUuid, {
                  status: 'completed',
                  results: targetResult.results,
                  input_tokens: inputTokens,
                  output_tokens: outputTokens
                });
              } else {
                // Usar el API interno si no tenemos un UUID válido
                await this.commandService.updateResults(command.id, targetResult.results);
                await this.commandService.updateStatus(command.id, 'completed');
                
                // Actualizar los tokens
                await this.commandService.updateCommand(command.id, {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens
                });
              }
            } else if (targetResult.status === 'failed') {
              console.error(`❌ Error en procesamiento de targets: ${targetResult.error}`);
              
              // Actualizar el estado del comando a failed
              if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                await DatabaseAdapter.updateCommand(dbUuid, {
                  status: 'failed',
                  error: targetResult.error
                });
              } else {
                await this.commandService.updateStatus(command.id, 'failed', targetResult.error);
              }
              return;
            }
          } catch (error: any) {
            console.error(`❌ Error al procesar targets: ${error.message}`);
            
            // Actualizar el estado del comando a failed
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, {
                status: 'failed',
                error: `Target processing error: ${error.message}`
              });
            } else {
              await this.commandService.updateStatus(command.id, 'failed', `Target processing error: ${error.message}`);
            }
            return;
          }
        } else {
          // Si no hay targets, completar el comando
          console.log(`⚠️ No hay targets para procesar en el comando: ${command.id}`);
          
          // Actualizar estado a 'completed'
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            await DatabaseAdapter.updateCommand(dbUuid, {
              status: 'completed'
            });
          } else {
            await this.commandService.updateStatus(command.id, 'completed');
          }
        }
      } catch (error: any) {
        console.error(`❌ Error al procesar comando ${command.id}:`, error);
        
        // Actualizar estado a 'failed'
        try {
          await this.commandService.updateStatus(command.id, 'failed', error.message);
        } catch (e) {
          console.error(`⚠️ Error adicional al actualizar estado a failed: ${e}`);
        }
      }
    });
  }
  
  // Ejecutar un comando de forma síncrona
  public async executeCommand(command: DbCommand): Promise<DbCommand> {
    // Crear el comando usando el servicio
    const commandId = await this.commandService.submitCommand(command);
    console.log(`🚀 Comando creado: ${commandId}`);
    
    // Esperar a que se complete - esto depende de la implementación del CommandService
    return new Promise((resolve, reject) => {
      // Configurar un timeout para evitar esperas infinitas
      const timeoutId = setTimeout(() => {
        reject(new Error('Command execution timed out'));
      }, 60000); // 60 segundos de timeout
      
      // Configurar un listener para el evento de completado
      const checkInterval = setInterval(async () => {
        try {
          const executedCommand = await this.commandService.getCommandById(commandId);
          
          if (executedCommand && (executedCommand.status === 'completed' || executedCommand.status === 'failed')) {
            clearTimeout(timeoutId);
            clearInterval(checkInterval);
            resolve(executedCommand);
          }
        } catch (error) {
          clearTimeout(timeoutId);
          clearInterval(checkInterval);
          reject(error);
        }
      }, 500); // Verificar cada 500ms
    });
  }
  
  // Obtener el servicio de comandos
  public getCommandService(): CommandService {
    return this.commandService;
  }
}

// Exportar la instancia única
export default ProcessorInitializer;