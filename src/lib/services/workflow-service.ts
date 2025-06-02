import { Connection, Client } from '@temporalio/client';

interface WorkflowExecutionArgs {
  email: string;
  from: string;
  subject: string;
  message: string;
  site_id: string; // Requerido para obtener configuración SMTP
  // Parámetros opcionales para logging
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

interface WorkflowExecutionResponse {
  success: boolean;
  executionId?: string;
  workflowId?: string;
  runId?: string;
  status?: string;
  error?: {
    code: string;
    message: string;
  };
}

// Interfaz para los datos de análisis
interface AnalysisData {
  summary: string;
  insights: string[];
  sentiment: "positive" | "negative" | "neutral";
  priority: "high" | "medium" | "low";
  action_items: string[];
  response: string[];
  lead_extraction: {
    contact_info: {
      name: string | null;
      email: string | null;
      phone: string | null;
      company: string | null;
    };
    intent: "inquiry" | "complaint" | "purchase" | "support" | "partnership" | "demo_request";
    requirements: string[];
    budget_indication: string | null;
    timeline: string | null;
    decision_maker: "yes" | "no" | "unknown";
    source: "website" | "referral" | "social_media" | "advertising" | "cold_outreach";
  };
  commercial_opportunity: {
    requires_response: boolean;
    response_type: "commercial" | "support" | "informational" | "follow_up";
    priority_level: "high" | "medium" | "low";
    suggested_actions: string[];
    potential_value: "high" | "medium" | "low" | "unknown";
    next_steps: string[];
  };
}

// Interfaz para programar soporte al cliente
interface ScheduleCustomerSupportParams {
  analysisArray: AnalysisData[];
  site_id: string;
  userId?: string;      //requerido
}

// Nueva interfaz para el workflow de WhatsApp
interface WhatsAppMessageWorkflowArgs {
  phoneNumber: string;
  messageContent: string;
  businessAccountId: string;
  messageId: string;
  conversationId: string;
  agentId: string;
  siteId: string;
  userId?: string; // ID del usuario dueño del sitio
  senderName?: string; // Nombre del perfil de WhatsApp del remitente
  visitorId?: string;
  leadId?: string;
}

export class WorkflowService {
  private static instance: WorkflowService;
  private client: Client | null = null;
  private connection: Connection | null = null;

  private constructor() {
    // Constructor privado para singleton
  }

  public static getInstance(): WorkflowService {
    if (!WorkflowService.instance) {
      WorkflowService.instance = new WorkflowService();
    }
    return WorkflowService.instance;
  }

  /**
   * Verifica la configuración de Temporal
   */
  public getTemporalConfig(): { serverUrl: string; namespace: string; isConfigured: boolean } {
    const serverUrl = this.getTemporalServerUrl();
    const namespace = this.getTemporalNamespace();
    const isConfigured = serverUrl !== 'localhost:7233' || process.env.TEMPORAL_SERVER_URL !== undefined;
    
    return {
      serverUrl,
      namespace,
      isConfigured
    };
  }

  /**
   * Obtiene la URL del servidor de Temporal
   */
  private getTemporalServerUrl(): string {
    return process.env.TEMPORAL_SERVER_URL || 'localhost:7233';
  }

  /**
   * Obtiene el namespace de Temporal
   */
  private getTemporalNamespace(): string {
    return process.env.TEMPORAL_NAMESPACE || 'default';
  }

  /**
   * Obtiene el API key de Temporal Cloud
   */
  private getTemporalApiKey(): string | undefined {
    return process.env.TEMPORAL_CLOUD_API_KEY;
  }

  /**
   * Verifica si el servidor Temporal está disponible
   */
  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const serverUrl = this.getTemporalServerUrl();
      const namespace = this.getTemporalNamespace();
      const apiKey = this.getTemporalApiKey();
      console.log(`🔍 Probando conexión a Temporal: ${serverUrl}`);
      console.log(`🔑 API Key configurado: ${apiKey ? 'Sí' : 'No'}`);
      
      // Configuración de conexión según la documentación oficial
      const connectionOptions: any = {
        address: serverUrl,
        connectTimeout: '5s',
      };

      // Si tenemos API key, es para Temporal Cloud y necesitamos TLS
      if (apiKey) {
        connectionOptions.tls = true;
        connectionOptions.apiKey = apiKey;
        connectionOptions.metadata = {
          'temporal-namespace': namespace,
        };
        console.log('🌐 Configurando para Temporal Cloud con TLS y API Key');
      } else {
        // Sin API key, asumimos servidor local sin TLS
        connectionOptions.tls = false;
        console.log('🏠 Configurando para servidor local sin TLS');
      }

      const testConnection = await Connection.connect(connectionOptions);
      
      await testConnection.close();
      console.log('✅ Conexión a Temporal exitosa');
      
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      console.error('❌ Error al probar conexión a Temporal:', errorMessage);
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Inicializa la conexión con Temporal
   */
  private async initializeClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    try {
      const serverUrl = this.getTemporalServerUrl();
      const namespace = this.getTemporalNamespace();
      const apiKey = this.getTemporalApiKey();

      console.log(`🔌 Conectando a Temporal: ${serverUrl}, namespace: ${namespace}`);
      console.log(`🔑 API Key configurado: ${apiKey ? 'Sí' : 'No'}`);

      // Configuración de conexión según la documentación oficial
      const connectionOptions: any = {
        address: serverUrl,
        connectTimeout: '10s',
      };

      // Si tenemos API key, es para Temporal Cloud y necesitamos TLS
      if (apiKey) {
        connectionOptions.tls = true;
        connectionOptions.apiKey = apiKey;
        connectionOptions.metadata = {
          'temporal-namespace': namespace,
        };
        console.log('🌐 Configurando para Temporal Cloud con TLS y API Key');
      } else {
        // Sin API key, asumimos servidor local sin TLS
        connectionOptions.tls = false;
        console.log('🏠 Configurando para servidor local sin TLS');
      }

      this.connection = await Connection.connect(connectionOptions);

      this.client = new Client({
        connection: this.connection,
        namespace,
      });

      console.log('✅ Cliente de Temporal inicializado exitosamente');
      return this.client;

    } catch (error) {
      console.error('❌ Error al inicializar cliente de Temporal:', error);
      console.error('📍 URL de servidor:', this.getTemporalServerUrl());
      console.error('📍 Namespace:', this.getTemporalNamespace());
      console.error('📍 API Key configurado:', this.getTemporalApiKey() ? 'Sí' : 'No');
      
      // Intentar logging adicional para diagnosticar el problema
      if (error instanceof Error) {
        console.error('📍 Mensaje de error:', error.message);
        console.error('📍 Stack trace:', error.stack);
      }
      
      throw error;
    }
  }

  /**
   * Cierra la conexión con Temporal
   */
  public async closeConnection(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.client = null;
      console.log('🔌 Conexión con Temporal cerrada');
    }
  }

  /**
   * Ejecuta un workflow para enviar email desde un agente
   */
  public async sendEmailFromAgent(args: WorkflowExecutionArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!args.email || !args.from || !args.subject || !args.message || !args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren email, from, subject, message y site_id para enviar el email'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `send-email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📧 Iniciando workflow de email: ${workflowId}`);
      console.log(`📋 Args:`, JSON.stringify(args, null, 2));
      console.log(`🔧 Using task queue: ${taskQueue}`);

      // Aquí se debería importar el workflow específico, por ahora uso un nombre genérico
      const handle = await client.workflow.start('sendEmailFromAgent', {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      return {
        success: true,
        executionId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: 'running'
      };

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de email:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow'
        }
      };
    }
  }

  /**
   * Ejecuta cualquier tipo de workflow genérico
   */
  public async executeWorkflow(workflowType: string, args: any, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `${workflowType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🔄 Ejecutando workflow ${workflowType}: ${workflowId}`);
      console.log(`🔧 Using task queue: ${taskQueue}`);

      const handle = await client.workflow.start(workflowType, {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow ${workflowType} iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      return {
        success: true,
        executionId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: 'running'
      };

    } catch (error) {
      console.error(`❌ Error al ejecutar workflow ${workflowType}:`, error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow'
        }
      };
    }
  }

  /**
   * Obtiene el estado de un workflow
   */
  public async getWorkflowStatus(workflowId: string, runId?: string): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const handle = client.workflow.getHandle(workflowId, runId);
      const description = await handle.describe();

      return {
        success: true,
        workflowId: description.workflowId,
        runId: description.runId,
        status: description.status.name.toLowerCase()
      };

    } catch (error) {
      console.error(`❌ Error al obtener estado del workflow ${workflowId}:`, error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_STATUS_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al obtener estado del workflow'
        }
      };
    }
  }

  /**
   * Cancela un workflow
   */
  public async cancelWorkflow(workflowId: string, runId?: string): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const handle = client.workflow.getHandle(workflowId, runId);
      await handle.cancel();

      console.log(`🚫 Workflow cancelado: ${workflowId}`);

      return {
        success: true,
        workflowId,
        runId,
        status: 'cancelled'
      };

    } catch (error) {
      console.error(`❌ Error al cancelar workflow ${workflowId}:`, error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_CANCEL_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al cancelar workflow'
        }
      };
    }
  }

  /**
   * Programa un workflow de customer support con análisis de emails
   */
  public async scheduleCustomerSupport(params: ScheduleCustomerSupportParams, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!params.analysisArray || !Array.isArray(params.analysisArray)) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere analysisArray como un arreglo válido'
          }
        };
      }

      if (!params.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para programar el soporte al cliente'
          }
        };
      }

      if (!params.userId) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere userId para programar el soporte al cliente'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `customer-support-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🎯 Programando workflow de customer support: ${workflowId}`);
      console.log(`📊 Análisis incluidos: ${params.analysisArray.length}`);
      console.log(`🏢 Site ID: ${params.site_id}`);
      console.log(`👤 User ID: ${params.userId}`);

      const handle = await client.workflow.start('scheduleCustomerSupportMessagesWorkflow', {
        args: [params],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de customer support programado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      return {
        success: true,
        executionId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: 'running'
      };

    } catch (error) {
      console.error('❌ Error al programar workflow de customer support:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al programar workflow de customer support'
        }
      };
    }
  }

  /**
   * Inicia el workflow para procesar y responder mensajes de WhatsApp
   */
  public async answerWhatsappMessage(args: WhatsAppMessageWorkflowArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!args.phoneNumber || !args.messageContent || !args.businessAccountId || !args.messageId || !args.conversationId || !args.agentId || !args.siteId) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren phoneNumber, messageContent, businessAccountId, messageId, conversationId, agentId y siteId para procesar el mensaje de WhatsApp'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `whatsapp-message-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📱 Iniciando workflow de WhatsApp: ${workflowId}`);
      console.log(`📱 Mensaje de ${args.phoneNumber.substring(0, 5)}*** en conversación ${args.conversationId}`);
      console.log(`🤖 Agente: ${args.agentId}`);
      console.log(`🏢 Site ID: ${args.siteId}`);
      console.log(`🔧 Using task queue: ${taskQueue}`);

      const handle = await client.workflow.start('answerWhatsappMessageWorkflow', {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de WhatsApp iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      return {
        success: true,
        executionId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: 'running'
      };

    } catch (error) {
      console.error('❌ Error al iniciar workflow de WhatsApp:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al iniciar workflow de WhatsApp'
        }
      };
    }
  }
}

export default WorkflowService;

// Exportar las interfaces para uso externo
export type { AnalysisData, ScheduleCustomerSupportParams, WhatsAppMessageWorkflowArgs, WorkflowExecutionResponse, WorkflowExecutionOptions }; 