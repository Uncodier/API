/**
 * AgentInitializer - Inicializa los procesadores y configura event listeners para Agentbase
 * 
 * FLUJO CORRECTO DE EJECUCIÓN:
 * 1. Llega comando con agent_id
 * 2. Se buscan datos del agente (en DB o procesador predefinido)
 * 3. Se genera agent_background
 * 4. Se evalúan herramientas
 * 5. Se ejecutan herramientas
 * 6. Se generan resultados de targets
 * 7. Se guarda comando y termina el flujo
 */
import { CommandService } from '../command/CommandService';
import { DbCommand } from '../../models/types';
import { Base } from '../../agents/Base';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import ProcessorConfigurationService from '../processor/ProcessorConfigurationService';
import CommandProcessor from '../command/CommandProcessor';
import { CommandCache } from '../command/CommandCache';
import { AgentBackgroundService } from './AgentBackgroundService';

// Singleton para la inicialización de los procesadores
export class AgentInitializer {
  private static instance: AgentInitializer;
  private initialized: boolean = false;
  private commandService: CommandService;
  private commandProcessor!: CommandProcessor; // Usando el operador ! para asegurar que será inicializado en initialize()
  private processors: Record<string, Base> = {};
  private agentBackgroundService: AgentBackgroundService;
  
  // Constructor privado para el patrón singleton
  private constructor() {
    this.commandService = new CommandService();
    this.agentBackgroundService = AgentBackgroundService.getInstance();
    console.log('🔧 AgentInitializer: Inicializando servicio de comandos');
  }
  
  // Obtener la instancia única
  public static getInstance(): AgentInitializer {
    if (!AgentInitializer.instance) {
      AgentInitializer.instance = new AgentInitializer();
    }
    return AgentInitializer.instance;
  }
  
  // Inicializar los procesadores y configurar los event listeners
  public initialize() {
    if (this.initialized) {
      console.log('🔍 AgentInitializer: Ya inicializado, omitiendo');
      return;
    }
    
    console.log('🚀 AgentInitializer: Inicializando procesadores y listeners');
    
    // Configurar los procesadores usando el servicio de configuración
    this.processors = ProcessorConfigurationService.configureProcessors();
    
    // Crear el procesador de comandos
    this.commandProcessor = new CommandProcessor(this.commandService, this.processors);
    
    // Configurar event listeners
    this.setupEventListeners();
    
    // Configurar CommandCache con el mismo event emitter que CommandService
    CommandCache.setEventEmitter(this.commandService.getEventEmitter());
    console.log('✅ AgentInitializer: CommandCache configurado con event emitter');
    
    this.initialized = true;
    console.log('✅ AgentInitializer: Inicialización completada');
  }
  
  // Configurar los event listeners para procesar comandos
  private setupEventListeners() {
    // Listener para el evento commandCreated
    this.commandService.on('commandCreated', async (command: DbCommand) => {
      console.log(`📥 Comando creado: ${command.id}, agente: ${command.agent_id}`);
      
      try {
        // PASO 1: Verificar y generar agent_background si es necesario
        if (command.agent_id && !command.agent_background) {
          console.log(`🔍 [AgentInitializer] Generando agent_background para agent_id: ${command.agent_id}`);
          
          // Determinar el procesador a utilizar
          let processor: Base | null = null;
          
          if (this.processors[command.agent_id]) {
            processor = this.processors[command.agent_id];
          } else if (DatabaseAdapter.isValidUUID(command.agent_id)) {
            processor = this.processors['tool_evaluator'];
          } else {
            throw new Error(`agent_id inválido: ${command.agent_id}`);
          }
          
          if (processor) {
            // Generar el background
            const agentBackground = await this.agentBackgroundService.generateAgentBackground(processor, command.agent_id, command.id);
            
            if (!agentBackground) {
              throw new Error(`No se pudo generar agent_background para ${command.agent_id}`);
            }
            
            // Actualizar el comando
            command = {
              ...command,
              agent_background: agentBackground
            };
            
            // Guardar en base de datos
            await DatabaseAdapter.updateCommand(command.id, {
              agent_background: agentBackground
            });
            
            // Guardar en caché
            CommandCache.setAgentBackground(command.id, agentBackground);
          } else {
            throw new Error(`No se pudo obtener procesador para agent_id: ${command.agent_id}`);
          }
        }
        
        // PASO 2: Procesar el comando
        console.log(`▶️ [AgentInitializer] Procesando comando ${command.id}`);
        await this.commandProcessor.processCommand(command);
        console.log(`✅ [AgentInitializer] Procesamiento completado: ${command.id}`);
        
      } catch (error: any) {
        console.error(`❌ [AgentInitializer] Error al procesar comando ${command.id}:`, error);
        
        // Actualizar estado a 'failed'
        try {
          await this.commandService.updateStatus(command.id, 'failed', error.message);
        } catch (e) {
          console.error(`⚠️ [AgentInitializer] Error adicional al actualizar estado: ${e}`);
        }
      }
    });
  }
  
  // Ejecutar un comando de forma síncrona
  public async executeCommand(command: DbCommand): Promise<DbCommand> {
    console.log(`▶️ [AgentInitializer] Ejecutando comando: ${command.id || 'nuevo'}`);
    
    // PASO 1: Generar agent_background si es necesario
    if (command.agent_id && !command.agent_background) {
      console.log(`🔍 [AgentInitializer] Generando agent_background para agent_id: ${command.agent_id}`);
      
      let processor: Base | null = null;
      
      // Determinar cómo obtener el processor basado en el agent_id
      if (this.processors[command.agent_id]) {
        processor = this.processors[command.agent_id];
      } else if (DatabaseAdapter.isValidUUID(command.agent_id)) {
        processor = this.processors['tool_evaluator']; // Procesador genérico
      } else {
        throw new Error(`agent_id inválido: ${command.agent_id}`);
      }
      
      if (processor) {
        // Generar el background usando AgentBackgroundService
        const agentBackground = await this.agentBackgroundService.generateAgentBackground(
          processor, command.agent_id, command.id
        );
        
        // Verificar que se generó correctamente
        if (!agentBackground || agentBackground.length < 10) {
          throw new Error(`No se pudo generar un agent_background válido para ${command.agent_id}`);
        }
        
        // Actualizar el comando
        command = { 
          ...command, 
          agent_background: agentBackground 
        };
      } else {
        throw new Error(`No se pudo obtener procesador para agent_id: ${command.agent_id}`);
      }
    } else if (!command.agent_background && !command.agent_id) {
      throw new Error(`Comando sin agent_id ni agent_background. Uno de ellos es obligatorio.`);
    }
    
    // PASO 2: Guardar el comando para procesamiento
    const originalAgentBackground = command.agent_background;
    const commandId = await this.commandService.submitCommand(command);
    
    // Guardar agent_background en caché directamente para asegurar disponibilidad
    if (originalAgentBackground) {
      CommandCache.setAgentBackground(commandId, originalAgentBackground);
    }
    
    // PASO 3: Esperar a que se complete el procesamiento
    console.log(`⏳ [AgentInitializer] Esperando procesamiento del comando ${commandId}`);
    
    // Función para verificar el estado del comando
    const checkCommandStatus = async (): Promise<DbCommand> => {
      const cmd = await this.commandService.getCommandById(commandId);
      
      // Restaurar agent_background si se perdió durante el procesamiento
      if (cmd && originalAgentBackground && !cmd.agent_background) {
        cmd.agent_background = originalAgentBackground;
      }
      
      return cmd as DbCommand;
    };
    
    // Definir timeout y límite de intentos
    const timeout = 30000; // 30 segundos máximo
    const maxAttempts = 60;
    const checkInterval = 500; // 500ms entre verificaciones
    
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout: El comando no se completó en el tiempo esperado'));
      }, timeout);
      
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const cmd = await checkCommandStatus();
          
          if (cmd && (cmd.status === 'completed' || cmd.status === 'failed')) {
            clearTimeout(timeoutId);
            console.log(`✅ [AgentInitializer] Comando ${commandId} completado con estado: ${cmd.status}`);
            resolve(cmd);
            return;
          }
          
          // Esperar antes de la siguiente verificación
          await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
        
        // Si llegamos aquí, se agotaron los intentos
        clearTimeout(timeoutId);
        const finalCommand = await checkCommandStatus();
        
        if (finalCommand) {
          console.warn(`⚠️ [AgentInitializer] Comando ${commandId} no completó ejecución, estado: ${finalCommand.status}`);
          resolve(finalCommand);
        } else {
          reject(new Error(`No se pudo obtener el comando ${commandId}`));
        }
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
  
  // Obtener el servicio de comandos
  public getCommandService(): CommandService {
    return this.commandService;
  }
}

// Exportar la instancia única
export default AgentInitializer.getInstance();