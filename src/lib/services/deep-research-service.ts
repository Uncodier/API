import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { waitForCommandCompletion, isValidUUID } from '@/lib/helpers/command-utils';

export interface DeepResearchResult {
  success: boolean;
  siteId: string;
  researchTopic: string;
  siteName?: string;
  siteUrl?: string;
  operations: Array<{
    type: string;
    objective: string;
    search_queries: string[];
    search_options: any;
    expected_deliverables: any;
  }>;
  operationResults: any[];
  analysis: any;
  insights: any[];
  recommendations: any[];
  commandId?: string;
  status?: string;
  message?: string;
  agent_id?: string;
  errors: string[];
  executionTime: string;
  completedAt: string;
}

export class DeepResearchService {
  private static instance: DeepResearchService;
  private processorInitializer: any;
  private commandService: any;

  private constructor() {
    this.processorInitializer = ProcessorInitializer.getInstance();
    this.processorInitializer.initialize();
    this.commandService = this.processorInitializer.getCommandService();
  }

  public static getInstance(): DeepResearchService {
    if (!DeepResearchService.instance) {
      DeepResearchService.instance = new DeepResearchService();
    }
    return DeepResearchService.instance;
  }

  // Función para encontrar agente con role "Data Analyst"
  private async findDataAnalystAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
    try {
      if (!siteId || !isValidUUID(siteId)) {
        console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
        return null;
      }
      
      console.log(`🔍 Buscando agente con role "Data Analyst" para el sitio: ${siteId}`);
      
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('id, user_id')
        .eq('site_id', siteId)
        .eq('role', 'Data Analyst')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (error) {
        console.error('Error al buscar agente con role "Data Analyst":', error);
        return null;
      }
      
      if (!data || data.length === 0) {
        console.log(`⚠️ No se encontró ningún agente con role "Data Analyst" activo para el sitio: ${siteId}`);
        return null;
      }
      
      console.log(`✅ Agente con role "Data Analyst" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
      return {
        agentId: data[0].id,
        userId: data[0].user_id
      };
    } catch (error) {
      console.error('Error al buscar agente Data Analyst:', error);
      return null;
    }
  }

  // Obtener información del sitio
  private async getSiteInfo(siteId: string): Promise<{name: string, url: string} | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('sites')
        .select('name, url')
        .eq('id', siteId)
        .single();
      
      if (error) {
        console.error('Error al obtener información del sitio:', error);
        return null;
      }
      
      return data;
    } catch (error) {
      console.error('Error al obtener información del sitio:', error);
      return null;
    }
  }

  // Función privada para ejecutar una operación de búsqueda
  private async executeSearchOperation(
    operation: any, 
    siteId: string, 
    agentId?: string
  ): Promise<{success: boolean, data?: any, error?: string}> {
    try {
      if (!operation.search_queries || !Array.isArray(operation.search_queries) || operation.search_queries.length === 0) {
        return {
          success: false,
          error: 'Operation does not contain valid search_queries array'
        };
      }

      // Preparar el payload para el endpoint de search
      const searchPayload = {
        site_id: siteId,
        search_queries: operation.search_queries,
        search_options: operation.search_options || {},
        agent_id: agentId
      };

      console.log(`🔍 Ejecutando operación de búsqueda con ${operation.search_queries.length} consultas`);

      // Hacer la llamada HTTP al endpoint de search
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/agents/dataAnalyst/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.SERVICE_API_KEY || ''
        },
        body: JSON.stringify(searchPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `API call failed: ${response.status} ${response.statusText}. ${errorText}`
        };
      }

      const searchResult = await response.json();
      
      if (!searchResult.success) {
        return {
          success: false,
          error: searchResult.error?.message || 'Search operation failed'
        };
      }

      console.log(`✅ Operación de búsqueda completada exitosamente`);
      return {
        success: true,
        data: searchResult.data
      };

    } catch (error) {
      console.error('❌ Error ejecutando operación de búsqueda:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred during search operation'
      };
    }
  }

  // Función privada para ejecutar análisis de los resultados de búsqueda
  private async executeAnalysis(
    siteId: string, 
    agentId?: string
  ): Promise<{success: boolean, data?: any, error?: string}> {
    try {
      console.log(`📊 Ejecutando análisis de los resultados de búsqueda`);

      // Hacer la llamada HTTP al endpoint de analysis
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/agents/dataAnalyst/analysis`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.SERVICE_API_KEY || ''
        },
        body: JSON.stringify({
          site_id: siteId,
          agent_id: agentId,
          analysis_type: 'comprehensive',
          include_raw_data: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Analysis API call failed: ${response.status} ${response.statusText}. ${errorText}`
        };
      }

      const analysisResult = await response.json();
      
      if (!analysisResult.success) {
        return {
          success: false,
          error: analysisResult.error?.message || 'Analysis operation failed'
        };
      }

      console.log(`✅ Análisis completado exitosamente`);
      return {
        success: true,
        data: analysisResult.data
      };

    } catch (error) {
      console.error('❌ Error ejecutando análisis:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred during analysis'
      };
    }
  }

  public async executeDeepResearch(
    siteId: string,
    researchTopic: string,
    researchDepth: string = 'comprehensive',
    context?: string,
    deliverables?: string
  ): Promise<DeepResearchResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    try {
      // Validar parámetros
      if (!siteId || !isValidUUID(siteId)) {
        throw new Error('site_id must be a valid UUID');
      }

      if (!researchTopic) {
        throw new Error('research_topic is required');
      }

      // Obtener información del sitio
      const siteInfo = await this.getSiteInfo(siteId);

      // Buscar agente Data Analyst
      const dataAnalystAgent = await this.findDataAnalystAgent(siteId);
      
      if (!dataAnalystAgent) {
        throw new Error('No se encontró un agente con role "Data Analyst" para este sitio');
      }

      // Construir el contexto del comando sin deliverables
      let commandContext = `Research Topic: ${researchTopic}\nDepth: ${researchDepth}`;
      commandContext += `\nMAKE A RESEARCH PLAN FOR THE TOPIC, BE SURE TU INCLUDE A SEARCH QUERY FOR EACH DELIVERABLE, OR A SEARCH OPERATION FOR EACH DELIVERABLE WHEN REQUIERED
      \nEXAMPLE: A DELIVERABLE IS A COMPLEX TOPIC THAT WILL REQUIERE SEVERAL CONSULTS AND A SPECIFIC PLAN TO GET RELEVANT INFORMATION, THEN YOU WILL BUILD A SPECIFIC SEARCH OPERATION FOR THAT DELIVERABLE OR INFO.
      `;
      if (context) {
        commandContext += `\nAdditional Context: ${context}`;
      }

      // Preparar targets incluyendo deliverables si está presente
      const baseOperation = {
        type: 'search',
        objective: 'Research objective description',
        search_queries: ['query string related to the research topic'],
        search_options: {
          search_depth: 'basic',
          max_results: 10,
          include_answer: true,
          include_images: false,
          include_domains: [],
          exclude_domains: []
        },
        expected_deliverables: deliverables || 'JSON object with description of expected results from this search operation'
      };

      const baseTarget = {
        research_plan: {
          operations: [baseOperation]
        }
      };

      // Crear comando para generar plan de búsqueda
      const commandData = CommandFactory.createCommand({
        task: 'generarte research plan',
        userId: dataAnalystAgent.userId,
        description: `Generate a comprehensive research plan for topic: ${researchTopic}, by separating different deliverables into different operations`,
        agentId: dataAnalystAgent.agentId,
        site_id: siteId,
        context: commandContext,
        targets: [baseTarget],
        tools: [],
        supervisor: [
          {
            agent_role: 'research_manager',
            status: 'not_initialized'
          }
        ],
      });
      
      console.log(`🔧 Creando comando de plan de investigación para topic: ${researchTopic}`);
      
      // Enviar comando para ejecución
      const commandId = await this.commandService.submitCommand(commandData);
      
      console.log(`📝 Comando de plan de investigación creado: ${commandId}`);
      
      // Esperar a que se complete el comando
      const { command: completedCommand, completed, dbUuid } = await waitForCommandCompletion(commandId, 100, 1000);
      
      if (!completed || !completedCommand) {
        errors.push('Failed to generate research plan - command did not complete');
      }
      
      // Usar el dbUuid (UUID final) en lugar del commandId provisional
      const finalCommandId = dbUuid || commandId;
      
      // Extraer las operaciones del plan de investigación
      let operations: any[] = [];
      
      if (completedCommand?.results && Array.isArray(completedCommand.results)) {
        for (const result of completedCommand.results) {
          if (result.research_plan && result.research_plan.operations) {
            operations = result.research_plan.operations;
            break;
          }
        }
      }

      if (operations.length === 0) {
        errors.push('No operations generated for the research topic');
      }
      
      console.log(`📊 Operaciones extraídas del plan de investigación: ${operations.length}`);
      
      // NUEVA FUNCIONALIDAD: Ejecutar las operaciones generadas
      const operationResults: any[] = [];
      
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i];
        console.log(`🔄 Ejecutando operación ${i + 1}/${operations.length}: ${operation.type}`);
        
        try {
          if (operation.type === 'search') {
            const operationResult = await this.executeSearchOperation(
              operation, 
              siteId, 
              dataAnalystAgent.agentId
            );
            
            if (operationResult.success) {
              operationResults.push({
                operation_index: i + 1,
                operation_type: operation.type,
                success: true,
                data: operationResult.data,
                timestamp: new Date().toISOString()
              });
            } else {
              errors.push(`Operation ${i + 1} failed: ${operationResult.error}`);
              operationResults.push({
                operation_index: i + 1,
                operation_type: operation.type,
                success: false,
                error: operationResult.error,
                timestamp: new Date().toISOString()
              });
            }
          } else {
            errors.push(`Operation ${i + 1} skipped: Unsupported operation type '${operation.type}'`);
            operationResults.push({
              operation_index: i + 1,
              operation_type: operation.type,
              success: false,
              error: `Unsupported operation type: ${operation.type}`,
              timestamp: new Date().toISOString()
            });
          }
        } catch (operationError) {
          const errorMsg = operationError instanceof Error ? operationError.message : 'Unknown error';
          errors.push(`Operation ${i + 1} failed with exception: ${errorMsg}`);
          operationResults.push({
            operation_index: i + 1,
            operation_type: operation.type,
            success: false,
            error: errorMsg,
            timestamp: new Date().toISOString()
          });
        }
        
        // Pequeña pausa entre operaciones
        if (i < operations.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Ejecutar análisis de los resultados
      let analysis: any = null;
      const analysisResult = await this.executeAnalysis(siteId, dataAnalystAgent.agentId);
      
      if (analysisResult.success) {
        analysis = analysisResult.data;
        console.log(`✅ Análisis de resultados completado`);
      } else {
        errors.push(`Analysis failed: ${analysisResult.error}`);
        console.log(`⚠️ Análisis falló: ${analysisResult.error}`);
      }
      
      const endTime = Date.now();
      const executionTime = `${((endTime - startTime) / 1000).toFixed(2)}s`;

      return {
        success: errors.length === 0,
        siteId,
        researchTopic,
        siteName: siteInfo?.name || 'Unknown',
        siteUrl: siteInfo?.url || '',
        operations,
        operationResults,
        analysis,
        insights: [],
        recommendations: [],
        commandId: finalCommandId,
        status: completed ? 'completed' : 'incomplete',
        message: completed ? 'Research plan generated successfully' : 'Research plan generation incomplete',
        agent_id: dataAnalystAgent.agentId,
        errors: errors.length > 0 ? errors : [],
        executionTime,
        completedAt: new Date().toISOString()
      };

    } catch (error) {
      const endTime = Date.now();
      const executionTime = `${((endTime - startTime) / 1000).toFixed(2)}s`;
      
      console.error('Error en executeDeepResearch:', error);
      
      return {
        success: false,
        siteId,
        researchTopic,
        siteName: 'Unknown',
        siteUrl: '',
        operations: [],
        operationResults: [],
        analysis: null,
        insights: [],
        recommendations: [],
        commandId: undefined,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Error desconocido durante la investigación profunda',
        agent_id: undefined,
        errors: [
          error instanceof Error ? error.message : 'Error desconocido durante la investigación profunda',
          ...errors
        ],
        executionTime,
        completedAt: new Date().toISOString()
      };
    }
  }
} 