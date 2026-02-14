import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface LeadQualificationWorkflowArgs {
  site_id: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

/**
 * API endpoint to execute the leadQualificationWorkflow in Temporal
 * POST /api/workflow/leadQualificationManagement
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Starting leadQualificationWorkflow execution');

    const body = await request.json();
    const { site_id } = body;

    if (!site_id || typeof site_id !== 'string') {
      console.error('❌ site_id is required and must be a string');
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_SITE_ID',
            message: 'site_id is required and must be a valid string'
          }
        },
        { status: 400 }
      );
    }

    console.log(`📝 Executing lead qualification workflow for site_id: ${site_id}`);

    const workflowService = WorkflowService.getInstance();

    const workflowArgs: LeadQualificationWorkflowArgs = {
      site_id
    };

    const workflowOptions: WorkflowExecutionOptions = {
      priority: 'high',
      async: false,
      retryAttempts: 3,
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `lead-qualification-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    console.log(`🔄 Starting lead qualification workflow with ID: ${workflowOptions.workflowId}`);

    const result = await workflowService.leadQualificationWorkflow(
      workflowArgs,
      workflowOptions
    );

    if (!result.success) {
      console.error('❌ Error executing lead qualification workflow:', result.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error executing lead qualification workflow'
          }
        },
        { status: 500 }
      );
    }

    console.log('✅ Lead qualification workflow executed successfully');
    console.log('📊 Lead qualification workflow result:', result);

    return NextResponse.json(
      {
        success: true,
        data: {
          site_id,
          workflowId: result.workflowId,
          executionId: result.executionId,
          runId: result.runId,
          status: result.status,
          result: result.data
        }
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('❌ Error in leadQualificationManagement workflow endpoint:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal server error while executing lead qualification workflow'
        }
      },
      { status: 500 }
    );
  }
}

/**
 * GET method to retrieve endpoint information
 */
export async function GET() {
  return NextResponse.json({
    name: 'leadQualificationManagement API',
    description: 'Executes the leadQualificationWorkflow in Temporal for lead qualification management',
    workflow_name: 'leadQualificationWorkflow',
    methods: ['POST'],
    requiredParams: {
      site_id: 'string - Site ID to run the lead qualification workflow'
    },
    workflow_steps: [
      '1. Lead Analysis - Analyze leads and their current qualification status',
      '2. Qualification Scoring - Apply qualification criteria and scoring',
      '3. Status Updates - Update lead qualification status',
      '4. Results Summary - Summary of qualification results'
    ],
    example: {
      site_id: 'site_12345'
    }
  });
}
