import { BaseWorkflowService, WorkflowExecutionOptions, WorkflowExecutionResponse } from './base-workflow-service';

// Interfaces específicas para workflows de negocio
interface EmailWorkflowArgs {
  email: string;
  from: string;
  subject: string;
  message: string;
  site_id: string;
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
}

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

interface ScheduleCustomerSupportParams {
  analysisArray: AnalysisData[];
  site_id: string;
  userId?: string;
}

interface WhatsAppMessageWorkflowArgs {
  phoneNumber: string;
  messageContent: string;
  businessAccountId: string;
  messageId: string;
  conversationId: string | null;
  agentId: string;
  siteId: string;
  userId?: string;
  senderName?: string;
  visitorId?: string;
  leadId?: string;
}

export class BusinessWorkflowService extends BaseWorkflowService {
  private static instance: BusinessWorkflowService;

  private constructor() {
    super();
  }

  public static getInstance(): BusinessWorkflowService {
    if (!BusinessWorkflowService.instance) {
      BusinessWorkflowService.instance = new BusinessWorkflowService();
    }
    return BusinessWorkflowService.instance;
  }

  /**
   * Ejecuta el workflow para enviar email desde agente
   */
  public async sendEmailFromAgent(args: EmailWorkflowArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.email || !args.from || !args.subject || !args.message || !args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren email, from, subject, message y site_id para enviar email'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `send-email-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📧 Iniciando workflow de envío de email: ${workflowId}`);

      const result = await client.workflow.execute('sendEmailFromAgentWorkflow', {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de envío de email completado: ${workflowId}`);

      return {
        success: true,
        workflowId,
        status: 'completed',
        data: result
      };

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de envío de email:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de envío de email'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para programar soporte al cliente
   */
  public async scheduleCustomerSupport(params: ScheduleCustomerSupportParams, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!params.analysisArray || !params.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren analysisArray y site_id para programar soporte'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `customer-support-${params.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🎧 Iniciando workflow de soporte al cliente: ${workflowId}`);

      const result = await client.workflow.execute('customerSupportWorkflow', {
        args: [params],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de soporte al cliente completado: ${workflowId}`);

      return {
        success: true,
        workflowId,
        status: 'completed',
        data: result
      };

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de soporte al cliente:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de soporte'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para responder mensajes de WhatsApp
   */
  public async answerWhatsappMessage(args: WhatsAppMessageWorkflowArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.phoneNumber || !args.messageContent || !args.agentId || !args.siteId) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren phoneNumber, messageContent, agentId y siteId para responder WhatsApp'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `whatsapp-${args.siteId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📱 Iniciando workflow de WhatsApp: ${workflowId}`);

      const result = await client.workflow.execute('whatsappMessageWorkflow', {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de WhatsApp completado: ${workflowId}`);

      return {
        success: true,
        workflowId,
        status: 'completed',
        data: result
      };

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de WhatsApp:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de WhatsApp'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow de daily standup del CMO
   */
  public async dailyStandUp(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para el daily standup'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `daily-standup-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📊 Iniciando workflow de daily standup: ${workflowId}`);
      console.log(`🏢 Site ID: ${args.site_id}`);
      console.log(`🔧 Task queue: ${taskQueue}`);

      // Si es asíncrono, solo iniciar el workflow
      if (options?.async !== false) {
        const handle = await client.workflow.start('dailyStandUpWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de daily standup iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        // Ejecutar workflow y esperar resultado
        const result = await client.workflow.execute('dailyStandUpWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de daily standup completado: ${workflowId}`);
        console.log(`📊 Resultado:`, result);

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de daily standup:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de daily standup'
        }
      };
    }
  }
}

// Exportar interfaces para uso externo
export type { 
  AnalysisData, 
  ScheduleCustomerSupportParams, 
  WhatsAppMessageWorkflowArgs, 
  EmailWorkflowArgs 
}; 