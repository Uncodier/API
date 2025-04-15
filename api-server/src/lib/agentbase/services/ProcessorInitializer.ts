/**
 * ProcessorInitializer - Inicializa los procesadores y configura event listeners para Agentbase
 */
import { CommandService } from './CommandService';
import { PortkeyConnector } from './PortkeyConnector';
import { AgentConnector } from '../agents/AgentConnector';
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
  // Mapa para traducir UUIDs de la base de datos a IDs internos de procesadores
  private dbUuidToProcessorId: Record<string, string> = {};
  // Caché de agentes recuperados de la base de datos con tiempo de expiración
  private agentCache: Record<string, {data: any, timestamp: number}> = {};
  // Tiempo de vida del caché en milisegundos (10 minutos)
  private readonly CACHE_TTL = 10 * 60 * 1000;
  
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
  
  // Registrar un mapeo entre UUID de la base de datos y ID interno de procesador
  public registerDbUuidMapping(dbUuid: string, processorId: string): void {
    this.dbUuidToProcessorId[dbUuid] = processorId;
    console.log(`🔗 Registrado mapeo de UUID ${dbUuid} a procesador ${processorId}`);
  }
  
  // Obtener el procesador correspondiente a un ID (puede ser interno o UUID de BD)
  private getProcessorById(id: string): Base | null {
    // Primero verificamos si es un ID interno
    if (this.processors[id]) {
      return this.processors[id];
    }
    
    // Si no, verificamos si es un UUID mapeado a un ID interno
    const internalId = this.dbUuidToProcessorId[id];
    if (internalId && this.processors[internalId]) {
      console.log(`🔍 UUID ${id} mapeado a procesador interno ${internalId}`);
      return this.processors[internalId];
    }
    
    // Si no encontramos coincidencia, usamos el procesador por defecto si existe
    if (this.processors['default_customer_support_agent']) {
      console.log(`⚠️ No se encontró procesador para ID ${id}, usando procesador por defecto`);
      return this.processors['default_customer_support_agent'];
    }
    
    console.log(`❌ No se encontró procesador para ID ${id}`);
    return null;
  }
  
  // Generar el background completo para un agente
  private async generateAgentBackground(processor: Base, agentId?: string): Promise<string> {
    // Si tenemos un agent_id UUID, intentar obtener información desde el caché o la base de datos
    if (agentId && DatabaseAdapter.isValidUUID(agentId)) {
      // Verificar primero en el caché y que no haya expirado
      const cacheEntry = this.agentCache[agentId];
      const now = Date.now();
      
      if (cacheEntry && (now - cacheEntry.timestamp) < this.CACHE_TTL) {
        console.log(`✅ Usando información del agente desde caché: ${agentId}`);
        const agentData = cacheEntry.data;
        
        // Lógica para extraer y generar el background a partir de los datos en caché
        // Prioridad de uso: systemPrompt > prompt > description > default
        const config = agentData.configuration || {};
        
        if (config.systemPrompt) {
          console.log(`🧠 Usando systemPrompt de caché para el agente ${agentId}`);
          return config.systemPrompt;
        }
        
        if (config.prompt) {
          console.log(`🧠 Usando prompt de caché para el agente ${agentId}`);
          return config.prompt;
        }
        
        // Construir un prompt con la información disponible
        const name = agentData.name || processor.getName();
        const description = config.description || agentData.description;
        const capabilities = config.capabilities || processor.getCapabilities();
        
        if (description) {
          console.log(`🧠 Construyendo prompt con description de caché para ${agentId}`);
          
          // Construir un prompt estructurado
          let agentBackground = `You are ${name} (ID: ${agentId}). ${description}

Your capabilities include: ${Array.isArray(capabilities) ? capabilities.join(', ') : 'providing assistance'}.

Instructions:
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;

          // Obtener los archivos del agente desde la caché si están disponibles
          if (cacheEntry.data.files && Array.isArray(cacheEntry.data.files)) {
            agentBackground = await this.appendAgentFilesToBackground(agentBackground, cacheEntry.data.files);
          }

          return agentBackground;
        }
      } else if (cacheEntry) {
        console.log(`⏰ Caché expirado para agente ${agentId}, consultando base de datos`);
        // Eliminar entrada expirada
        delete this.agentCache[agentId];
      }
      
      // Si no está en caché o expiró, buscar en la base de datos
      try {
        console.log(`🔍 Buscando información del agente en la base de datos: ${agentId}`);
        const agentData = await DatabaseAdapter.getAgentById(agentId);
        
        if (agentData) {
          // Obtener los archivos del agente desde la base de datos
          console.log(`🔍 Buscando archivos del agente en la base de datos: ${agentId}`);
          const agentFiles = await DatabaseAdapter.getAgentFiles(agentId);
          
          // Añadir los archivos a los datos del agente
          if (agentFiles && agentFiles.length > 0) {
            agentData.files = agentFiles;
          }
          
          // Guardar en caché para futuras consultas
          this.agentCache[agentId] = { data: agentData, timestamp: Date.now() };
          console.log(`✅ Información del agente encontrada en la base de datos y guardada en caché: ${agentId}`);
          
          // Verificar si hay systemPrompt o description en la base de datos
          const config = agentData.configuration || {};
          
          // Prioridad de uso: systemPrompt > prompt > description > default
          if (config.systemPrompt) {
            console.log(`🧠 Usando systemPrompt de la base de datos para el agente ${agentId}`);
            return config.systemPrompt;
          }
          
          if (config.prompt) {
            console.log(`🧠 Usando prompt de la base de datos para el agente ${agentId}`);
            return config.prompt;
          }
          
          // Construir un prompt con la información disponible
          const name = agentData.name || processor.getName();
          const description = config.description || agentData.description;
          const capabilities = config.capabilities || processor.getCapabilities();
          
          if (description) {
            console.log(`🧠 Construyendo prompt con description de la base de datos para ${agentId}`);
            
            // Construir un prompt estructurado
            let agentBackground = `You are ${name} (ID: ${agentId}). ${description}

Your capabilities include: ${Array.isArray(capabilities) ? capabilities.join(', ') : 'providing assistance'}.

Instructions:
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;

            // Añadir los archivos del agente al background si existen
            if (agentFiles && agentFiles.length > 0) {
              agentBackground = await this.appendAgentFilesToBackground(agentBackground, agentFiles);
            }

            return agentBackground;
          }
        }
      } catch (error) {
        console.error(`❌ Error al obtener información del agente desde la base de datos:`, error);
        // Fallback a usar información del procesador si hay error
      }
    }
    
    // Si no se pudo obtener información de la base de datos, usar la del procesador
    console.log(`🔄 Usando información del procesador local para agent_background`);
    
    // Obtener la información básica del agente directamente de la instancia
    const id = processor.getId();
    const name = processor.getName();
    const capabilities = processor.getCapabilities();
    
    // Obtener todas las propiedades disponibles del agente
    const processorProps = Object.getOwnPropertyNames(processor)
      .filter(prop => typeof (processor as any)[prop] !== 'function' && prop !== 'id' && prop !== 'name');
    
    console.log(`🔍 Propiedades del agente ${id}: ${processorProps.join(', ')}`);
    
    // Si el agente tiene una propiedad customPrompt o systemPrompt, usarla directamente
    if ((processor as any).systemPrompt) {
      console.log(`✅ Usando systemPrompt personalizado del agente ${id}`);
      return (processor as any).systemPrompt;
    }
    
    if ((processor as any).customPrompt) {
      console.log(`✅ Usando customPrompt personalizado del agente ${id}`);
      return (processor as any).customPrompt;
    }
    
    if ((processor as any).prompt) {
      console.log(`✅ Usando prompt personalizado del agente ${id}`);
      return (processor as any).prompt;
    }
    
    if ((processor as any).background) {
      console.log(`✅ Usando background personalizado del agente ${id}`);
      return (processor as any).background;
    }
    
    // Si el agente tiene una propiedad description, usarla en el prompt
    const description = (processor as any).description || 
                       `An AI assistant with capabilities in ${capabilities.join(', ')}`;
    
    // Construir un prompt básico con la información disponible
    const agentBackground = `You are ${name} (ID: ${id}). ${description}

Your capabilities include: ${capabilities.join(', ')}.

Instructions:
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;
    
    console.log(`⚠️ No se encontró prompt específico para el agente ${id}, usando generado:
${agentBackground}`);
    
    return agentBackground;
  }
  
  /**
   * Añade el contenido de los archivos del agente al background
   * Especialmente procesa los archivos CSV para incluirlos directamente
   */
  private async appendAgentFilesToBackground(background: string, files: any[]): Promise<string> {
    if (!files || files.length === 0) {
      console.log(`⚠️ No hay archivos para añadir al background`);
      return background;
    }
    
    console.log(`🔍 Procesando ${files.length} archivos para añadir al background`);
    let updatedBackground = background;
    let csvFilesAdded = 0;
    
    try {
      // Añadir sección específica para archivos
      updatedBackground += '\n\n## Reference Files';
      
      for (const file of files) {
        try {
          // Determinar tipo de archivo - múltiples formas de verificar
          const fileType = file.file_type?.toLowerCase() || '';
          const fileName = file.name || file.file_path?.split('/').pop() || 'unnamed_file';
          const filePath = file.file_path || file.id; // Usar path o ID si path no está disponible
          
          console.log(`📄 Procesando archivo: ${fileName} (${fileType || 'tipo desconocido'}), path: ${filePath}`);
          
          // Verificar si es un CSV de múltiples formas
          const isCSV = fileType === 'csv' || 
                       fileName.toLowerCase().endsWith('.csv') || 
                       (file.metadata && file.metadata.mime_type === 'text/csv') ||
                       (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.csv')) ||
                       (file.public_url && typeof file.public_url === 'string' && file.public_url.toLowerCase().includes('.csv'));
          
          // Si es un archivo CSV, obtener y añadir su contenido directamente
          if (isCSV) {
            console.log(`📊 Archivo CSV detectado: ${fileName}, intentando obtener contenido...`);
            console.log(`📊 URL del archivo: ${file.public_url || 'No disponible'}`);
            
            // Intentar obtener el contenido directamente de la URL pública si está disponible
            let fileContent = null;
            
            if (file.public_url) {
              try {
                console.log(`🌐 Intentando obtener directamente desde URL pública: ${file.public_url}`);
                const response = await fetch(file.public_url);
                if (response.ok) {
                  fileContent = await response.text();
                  console.log(`✅ Contenido obtenido directamente de URL pública (${fileContent.length} bytes)`);
                } else {
                  console.warn(`⚠️ Error al obtener contenido de URL pública: ${response.status} ${response.statusText}`);
                }
              } catch (urlError) {
                console.error(`❌ Error al obtener desde URL:`, urlError);
              }
            }
            
            // Si no se pudo obtener desde la URL, intentar con el método habitual
            if (!fileContent) {
              fileContent = await this.getCSVContent(file);
            }
            
            if (fileContent) {
              // Añadir el contenido CSV directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`csv\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido CSV añadido para: ${fileName} (${fileContent.length} caracteres)`);
              csvFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo CSV: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nCSV file reference (content could not be loaded)`;
            }
          } else {
            // Para otros tipos de archivos, solo añadir una referencia
            console.log(`📎 Añadiendo referencia para archivo no-CSV: ${fileName}`);
            updatedBackground += `\n\n### ${fileName}\nReference file of type: ${fileType || 'unknown'}`;
          }
        } catch (fileError: any) {
          console.error(`❌ Error al procesar archivo individual para background:`, fileError);
          // Continuar con el siguiente archivo
        }
      }
      
      console.log(`✅ Procesamiento de archivos completado: ${csvFilesAdded} archivos CSV añadidos al background`);
      
      if (csvFilesAdded === 0) {
        console.warn(`⚠️ No se añadió ningún contenido CSV al background. Revise que los archivos existan y sean accesibles.`);
      }
      
      return updatedBackground;
    } catch (error: any) {
      console.error(`❌ Error general al procesar archivos para background:`, error);
      // En caso de error, devolver el background original
      return background;
    }
  }
  
  // Actualizar agent_background en la base de datos de forma optimizada
  private async updateAgentBackgroundInDb(command: DbCommand, agentBackground: string): Promise<boolean> {
    try {
      const dbUuid = command.metadata?.dbUuid || command.id;
      
      // Verificar si podemos usar el adaptador de base de datos
      if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
        console.log(`📝 Guardando agent_background en DB para comando ${dbUuid}`);
        
        // Crear objeto de actualización con agent_background
        const updateData = {
          agent_background: agentBackground
        };
        
        // Realizar una única actualización a la base de datos
        await DatabaseAdapter.updateCommand(dbUuid, updateData);
        console.log(`✅ agent_background guardado en DB para comando ${dbUuid}`);
        return true;
      } else {
        // Usar el CommandService como alternativa para IDs no-UUID
        console.log(`📝 Guardando agent_background usando CommandService para comando ${command.id}`);
        await this.commandService.updateCommand(command.id, {
          agent_background: agentBackground
        });
      }
      
      return false;
    } catch (error) {
      console.error(`❌ Error al guardar agent_background:`, error);
      return false;
    }
  }
  
  // Limpiar entradas de caché expiradas
  private cleanExpiredCache(): void {
    const now = Date.now();
    let expiredCount = 0;
    
    // Revisar y eliminar entradas expiradas
    for (const agentId in this.agentCache) {
      const cacheEntry = this.agentCache[agentId];
      if ((now - cacheEntry.timestamp) >= this.CACHE_TTL) {
        delete this.agentCache[agentId];
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      console.log(`🧹 Limpieza de caché: ${expiredCount} entradas expiradas eliminadas`);
    }
  }
  
  // Inicializar los procesadores y configurar los event listeners
  public initialize() {
    if (this.initialized) {
      console.log('🔍 ProcessorInitializer: Ya inicializado, omitiendo');
      return;
    }
    
    console.log('🚀 ProcessorInitializer: Inicializando procesadores y listeners');
    
    // Limpiar el caché por si acaso
    this.cleanExpiredCache();
    
    // Configurar una limpieza periódica del caché (cada 5 minutos)
    setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
    
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
    this.processors['default_customer_support_agent'] = new AgentConnector(
      'default_customer_support_agent',
      'Customer Support Agent',
      connector,
      ['customer_support', 'order_tracking', 'issue_resolution'],
      {
        defaultOptions: {
          modelType: 'openai',
          modelId: 'gpt-4o',
          maxTokens: 4000,
          temperature: 0.7
        },
        description: "Agente de soporte al cliente especializado en resolver problemas relacionados con pedidos, productos y servicios.",
        systemPrompt: `You are a customer support agent. Your role is to help customers with their inquiries, solve problems, and provide excellent service.

Instructions:
1. Be friendly and professional at all times.
2. Address the customer's questions directly.
3. If you don't know an answer, be honest about it.
4. Prioritize customer satisfaction above all else.
5. Be empathetic to customer concerns.
6. Your name is "Customer Support Agent" - whenever asked about your name, identity or what you are, respond with this name.

Remember that you represent the company and should maintain a helpful, positive attitude.`
      }
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
      },
      // Propiedades adicionales para el agente
      "Evaluador de herramientas que analiza y selecciona las mejores herramientas para una tarea.",
      `You are a tool evaluator. Your job is to analyze tools and select the most appropriate ones for a given task.

Instructions:
1. Analyze each tool's capabilities and limitations.
2. Select tools that best match the requirements of the task.
3. Provide clear reasoning for your selections.
4. Consider efficiency, effectiveness, and appropriateness.
5. Your name is "Tool Evaluator" - whenever asked about your name, identity or what you are, respond with this name.`
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
      },
      // Propiedades adicionales para el agente
      "Procesador de targets que genera respuestas específicas para diferentes tipos de contenido.",
      `You are a target processor. Your role is to generate specific content based on defined targets.

Instructions:
1. Create content that precisely matches the requested targets.
2. Ensure all responses follow the specified format.
3. Be concise and direct in your responses.
4. Adapt your tone and style to the target requirements.
5. Your name is "Target Processor" - whenever asked about your name, identity or what you are, respond with this name.`
    );
    
    // Configurar event listeners
    this.setupEventListeners();
    
    // Configurar mapeos por defecto de UUIDs
    // Estos mapeos deben ser configurados desde fuera o cargados desde configuración
    // Por ahora establecemos un mapeo de ejemplo para soporte al cliente
    this.registerDbUuidMapping('478d3106-7391-4d9a-a5c1-8466202b45a9', 'default_customer_support_agent');
    
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
        // y solo si no se ha establecido previamente
        if (command.agent_id && !command.agent_background) {
          // Obtener el procesador correspondiente al agent_id (puede ser UUID o ID interno)
          const processor = this.getProcessorById(command.agent_id);
          
          if (processor) {
            const agentBackground = await this.generateAgentBackground(processor, command.agent_id);
            
            console.log(`🤖 Estableciendo agent_background para agente: ${command.agent_id} -> ${processor.getId()}`);
            
            // Actualizar el comando con la información del agente
            command = {
              ...command,
              agent_background: agentBackground
            };
            
            // Guardar esta información en la base de datos
            await this.updateAgentBackgroundInDb(command, agentBackground);
          } else {
            console.log(`⚠️ No se encontró procesador para el agent_id: ${command.agent_id}`);
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
                
                // Preparar objeto para actualización en lote
                let updateBatch: any = {};
                
                // Actualizar las herramientas
                const evaluationResult = toolResult.results.find(r => r.type === 'tool_evaluation');
                if (evaluationResult && evaluationResult.content && evaluationResult.content.updated_tools) {
                  // Actualizar las herramientas en el comando preservando agent_background
                  command = {
                    ...command,
                    tools: evaluationResult.content.updated_tools
                  };
                  
                  // Añadir herramientas al lote de actualización
                  updateBatch.tools = command.tools;
                }
                
                // Actualizar tokens acumulados
                if (toolResult.inputTokens || toolResult.outputTokens) {
                  const inputTokens = Number(command.input_tokens || 0) + Number(toolResult.inputTokens || 0);
                  const outputTokens = Number(command.output_tokens || 0) + Number(toolResult.outputTokens || 0);
                  
                  // Actualizar tokens en el comando preservando agent_background
                  command = {
                    ...command,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens
                  };
                  
                  // Añadir tokens al lote de actualización
                  updateBatch.input_tokens = inputTokens;
                  updateBatch.output_tokens = outputTokens;
                  
                  console.log(`🔢 Tokens acumulados después de evaluación: input=${inputTokens}, output=${outputTokens}`);
                }
                
                // Realizar actualización en lote si hay cambios
                if (Object.keys(updateBatch).length > 0 && dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                  console.log(`📝 Actualizando en lote después de evaluación: ${Object.keys(updateBatch).join(', ')}`);
                  await DatabaseAdapter.updateCommand(dbUuid, updateBatch);
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
            
            // Actualizar el estado del comando a failed en una única operación
            const failureUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
              status: 'failed' as any,
              error: `Tool evaluation error: ${error.message}`
            };
            
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, failureUpdate);
            } else {
              await this.commandService.updateCommand(command.id, failureUpdate);
            }
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
            
            // Comprobar si el comando tiene agent_background
            console.log(`🔍 Agent background presente: ${command.agent_background ? 'Sí' : 'No'}`);
            
            // Ejecutar el procesamiento
            const targetResult = await targetProcessor.executeCommand(command);
            
            if (targetResult.status === 'completed' && targetResult.results) {
              console.log(`✅ Procesamiento de targets completado para: ${command.id}`);
              
              // Preparar un único objeto para actualización en lote
              const updateBatch: any = {
                status: 'completed',
                results: targetResult.results
              };
              
              // Calcular tokens acumulados para añadir al lote de actualización
              const currentInputTokens = Number(command.input_tokens || 0);
              const currentOutputTokens = Number(command.output_tokens || 0);
              const inputTokens = currentInputTokens + Number(targetResult.inputTokens || 0);
              const outputTokens = currentOutputTokens + Number(targetResult.outputTokens || 0);
              
              updateBatch.input_tokens = inputTokens;
              updateBatch.output_tokens = outputTokens;
              
              // Añadir el modelo usado si está disponible en el comando actualizado
              if (targetResult.updatedCommand && targetResult.updatedCommand.model) {
                updateBatch.model = targetResult.updatedCommand.model;
                console.log(`🤖 Modelo utilizado: ${updateBatch.model}`);
              }
              
              console.log(`🔢 Tokens acumulados: input=${inputTokens}, output=${outputTokens}`);
              
              // Realizar una única actualización en la base de datos
              if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                console.log(`🔄 Actualizando resultados y estado en una sola operación para: ${dbUuid}`);
                await DatabaseAdapter.updateCommand(dbUuid, updateBatch);
              } else {
                // Usar el API interno si no tenemos un UUID válido
                console.log(`🔄 Actualizando resultados y estado con CommandService para: ${command.id}`);
                await this.commandService.updateCommand(command.id, updateBatch);
              }
            } else if (targetResult.status === 'failed') {
              console.error(`❌ Error en procesamiento de targets: ${targetResult.error}`);
              
              // Actualizar el estado del comando a failed en una sola operación
              const failureUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
                status: 'failed' as any,
                error: targetResult.error
              };
              
              if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
                await DatabaseAdapter.updateCommand(dbUuid, failureUpdate);
              } else {
                await this.commandService.updateCommand(command.id, failureUpdate);
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
          
          // Actualizar estado a 'completed' en una única operación
          const completedUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
            status: 'completed' as any
          };
          
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            await DatabaseAdapter.updateCommand(dbUuid, completedUpdate);
          } else {
            await this.commandService.updateCommand(command.id, completedUpdate);
          }
        }
      } catch (error: any) {
        console.error(`❌ Error al procesar comando ${command.id}:`, error);
        
        // Actualizar estado a 'failed' en una única operación
        try {
          const errorDbUuid = command.metadata?.dbUuid || command.id;
          const failureUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
            status: 'failed' as any,
            error: error.message
          };
          
          if (errorDbUuid && DatabaseAdapter.isValidUUID(errorDbUuid)) {
            await DatabaseAdapter.updateCommand(errorDbUuid, failureUpdate);
          } else {
            await this.commandService.updateCommand(command.id, failureUpdate);
          }
        } catch (e) {
          console.error(`⚠️ Error adicional al actualizar estado a failed: ${e}`);
        }
      }
    });
  }
  
  // Ejecutar un comando de forma síncrona
  public async executeCommand(command: DbCommand): Promise<DbCommand> {
    // Si hay un agent_id, establecer el agent_background inmediatamente
    if (command.agent_id && !command.agent_background) {
      // Obtener el procesador correspondiente al agent_id (puede ser UUID o ID interno)
      const processor = this.getProcessorById(command.agent_id);
      
      if (processor) {
        const agentBackground = await this.generateAgentBackground(processor, command.agent_id);
        
        // Actualizar el comando con la información del agente localmente
        // pero no intentar guardar en DB porque el comando aún no existe
        command = {
          ...command,
          agent_background: agentBackground
        };
        
        console.log(`🤖 Estableciendo agent_background para agente: ${command.agent_id} -> ${processor.getId()}`);
      } else {
        console.log(`⚠️ No se encontró procesador para el agent_id: ${command.agent_id}`);
      }
    }
    
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
  
  /**
   * Descarga contenido directamente desde una URL
   */
  private async downloadFromUrl(url: string): Promise<string | null> {
    if (!url) return null;
    
    try {
      console.log(`🌐 Intentando descargar directamente desde URL: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'text/plain,text/csv,application/octet-stream,*/*',
          'User-Agent': 'Agentbase/1.0'
        }
      });
      
      if (!response.ok) {
        console.error(`⚠️ Error al descargar de URL: ${response.status} ${response.statusText}`);
        return null;
      }
      
      const content = await response.text();
      console.log(`✅ Contenido descargado con éxito de URL (${content.length} bytes)`);
      
      // Análisis básico para verificar si es un CSV
      if (url.toLowerCase().endsWith('.csv')) {
        const lines = content.split(/\r?\n/).filter(line => line.trim());
        if (lines.length > 0) {
          console.log(`📊 CSV tiene ${lines.length} líneas. Primera línea: ${lines[0]}`);
        }
      }
      
      return content;
    } catch (error: any) {
      console.error(`❌ Error al descargar contenido: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Obtiene el contenido CSV de un archivo específico
   * Implementa lógica adicional para manejar errores y formatear CSV
   */
  private async getCSVContent(file: any): Promise<string | null> {
    try {
      console.log(`📊 Obteniendo contenido CSV para: ${file.name || file.file_path}`);
      
      // Intento 1: Si hay una URL pública disponible, intentar descargar directamente
      if (file.public_url) {
        console.log(`🔍 Archivo tiene URL pública: ${file.public_url}`);
        const urlContent = await this.downloadFromUrl(file.public_url);
        if (urlContent) {
          console.log(`✅ Contenido obtenido desde URL pública`);
          return urlContent;
        }
      }
      
      // Intentar obtener el archivo usando diversos enfoques
      const filePath = file.file_path || file.id;
      
      // Intento 2: Usar el método estándar
      let content = await DatabaseAdapter.getAgentFileContent(filePath);
      
      if (!content) {
        console.log(`⚠️ No se pudo obtener CSV por método estándar, intentando con asset_id: ${file.id}`);
        // Intento 3: Usar directamente el ID del asset
        content = await DatabaseAdapter.getAgentFileContent(file.id);
      }
      
      if (!content && file.file_path && typeof file.file_path === 'string') {
        // Intento 4: Si file_path parece ser una URL completa, intentar descarga directa
        if (file.file_path.startsWith('http')) {
          console.log(`🔍 File path parece ser una URL, intentando descarga directa: ${file.file_path}`);
          content = await this.downloadFromUrl(file.file_path);
        }
      }
      
      if (!content) {
        console.error(`❌ No se pudo obtener contenido CSV para: ${file.name || file.id}`);
        return null;
      }
      
      // Verificar que el contenido sea realmente un CSV
      if (!this.isValidCSV(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un CSV válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        return null;
      }
      
      console.log(`✅ Contenido CSV obtenido correctamente (${content.length} bytes)`);
      return content;
    } catch (error: any) {
      console.error(`❌ Error al obtener CSV:`, error);
      return null;
    }
  }
  
  /**
   * Valida si un contenido tiene formato CSV
   */
  private isValidCSV(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    // Verificar que contenga separadores de columna y al menos una línea
    if (!content.includes(',') || (!content.includes('\n') && !content.includes('\r'))) {
      return false;
    }
    
    // Verificar que tenga múltiples líneas
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) { // Al menos encabezado y una fila de datos
      return false;
    }
    
    // Verificar que las líneas tengan formato de columnas
    return lines.every(line => line.includes(','));
  }
}

// Exportar la instancia única
export default ProcessorInitializer;