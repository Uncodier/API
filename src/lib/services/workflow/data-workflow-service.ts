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
} 