import { BaseWorkflowService, WorkflowExecutionOptions, WorkflowExecutionResponse } from './base-workflow-service';

export class DataWorkflowService extends BaseWorkflowService {
  private static instance: DataWorkflowService;

  private constructor() {
    super();
  }

  public static getInstance(): DataWorkflowService {
    if (!DataWorkflowService.instance) {
      DataWorkflowService.instance = new DataWorkflowService();
    }
    return DataWorkflowService.instance;
  }

  /**
   * Ejecuta el workflow para construir campañas
   */
  public async buildCampaigns(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir campañas'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-campaigns-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🏗️ Iniciando workflow de construcción de campañas: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('buildCampaignsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('buildCampaignsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de campañas:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de campañas'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para construir contenido
   */
  public async buildContent(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir contenido'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-content-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📝 Iniciando workflow de construcción de contenido: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('buildContentWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('buildContentWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de contenido:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de contenido'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para construir segmentos
   */
  public async buildSegments(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir segmentos'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-segments-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`👥 Iniciando workflow de construcción de segmentos: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('buildSegmentsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('buildSegmentsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de segmentos:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de segmentos'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para construir segmentos ICP
   */
  public async buildSegmentsICP(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir segmentos ICP'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-segments-icp-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🎯 Iniciando workflow de construcción de segmentos ICP: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('buildSegmentsICPWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('buildSegmentsICPWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de segmentos ICP:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de segmentos ICP'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para seguimiento de leads
   */
  public async leadFollowUp(args: { site_id: string; lead_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id || !args.lead_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren site_id y lead_id para el seguimiento de lead'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `lead-follow-up-${args.site_id}-${args.lead_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📞 Iniciando workflow de seguimiento de lead: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('leadFollowUpWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('leadFollowUpWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de seguimiento de lead:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de seguimiento de lead'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para investigación de leads
   */
  public async leadResearch(args: { site_id: string; lead_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id || !args.lead_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren site_id y lead_id para la investigación de lead'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `lead-research-${args.site_id}-${args.lead_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🔍 Iniciando workflow de investigación de lead: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('leadResearchWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('leadResearchWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de investigación de lead:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de investigación de lead'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para generación de leads
   */
  public async leadGeneration(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para la generación de leads'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `lead-generation-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🎯 Iniciando workflow de generación de leads: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('leadGenerationWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('leadGenerationWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de generación de leads:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de generación de leads'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para análisis de sitio
   */
  public async analyzeSite(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para el análisis de sitio'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `analyze-site-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🔍 Iniciando workflow de análisis de sitio: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('analyzeSiteWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('analyzeSiteWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de análisis de sitio:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de análisis de sitio'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para asignación de leads
   */
  public async assignLeads(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para la asignación de leads'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `assign-leads-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📋 Iniciando workflow de asignación de leads: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('assignLeadsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('assignLeadsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de asignación de leads:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de asignación de leads'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para invalidación de leads
   */
  public async leadInvalidation(args: { 
    lead_id: string; 
    email: string; 
    site_id: string; 
    reason: 'email_bounce' | 'invalid_email' | 'manual_invalidation';
    bounce_details?: {
      bounce_email_id: string;
      bounce_subject?: string;
      bounce_from?: string;
      bounce_date?: string;
      bounce_message?: string;
    };
    metadata?: {
      invalidated_by?: string;
      user_id?: string;
      additional_info?: any;
    };
  }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.lead_id || !args.email || !args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren lead_id, email y site_id para la invalidación de lead'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `lead-invalidation-${args.lead_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🚫 Iniciando workflow de invalidación de lead: ${workflowId}`);
      console.log(`👤 Lead ID: ${args.lead_id}, Email: ${args.email}, Razón: ${args.reason}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('leadInvalidationWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('leadInvalidationWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de invalidación de lead:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de invalidación de lead'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow de prospección diaria
   */
  public async dailyProspectionWorkflow(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para la prospección diaria'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `daily-prospection-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🎯 Iniciando workflow de prospección diaria: ${workflowId}`);

      if (options?.async !== false) {
        const handle = await client.workflow.start('dailyProspectionWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        const result = await client.workflow.execute('dailyProspectionWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de prospección diaria:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de prospección diaria'
        }
      };
    }
  }
} 