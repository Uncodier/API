import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Interface para los parámetros del workflow de setup del sitio
interface SiteSetupWorkflowArgs {
  site_id: string;
  user_id?: string;
  setup_type?: 'basic' | 'advanced' | 'complete';
  options?: {
    enable_analytics?: boolean;
    enable_chat?: boolean;
    enable_leads?: boolean;
    enable_email_tracking?: boolean;
    default_timezone?: string;
    default_language?: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros requeridos de la solicitud
    const { site_id, user_id, setup_type, options } = body;
    
    // Validar que site_id sea requerido
    if (!site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Validar que site_id sea un UUID válido
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Validar user_id si se proporciona
    if (user_id && !isValidUUID(user_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'user_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`🏗️ Iniciando setup del sitio: ${site_id}`);
    console.log(`👤 Usuario: ${user_id || 'N/A'}`);
    console.log(`🔧 Tipo de setup: ${setup_type || 'basic'}`);
    
    // Crear registro de billing inicial con 30 créditos
    try {
      // Verificar si ya existe un registro de billing para este sitio
      const { data: existingBilling } = await supabaseAdmin
        .from('billing')
        .select('id')
        .eq('site_id', site_id)
        .maybeSingle();
        
      if (!existingBilling) {
        console.log(`💳 Creando registro de billing inicial para el sitio: ${site_id} con 30 créditos`);
        const { error: billingError } = await supabaseAdmin
          .from('billing')
          .insert({
            site_id,
            plan: 'free',
            credits_available: 30,
            credits_used: 0,
            status: 'active'
          });
          
        if (billingError) {
          console.error(`❌ Error al crear registro de billing para el sitio ${site_id}:`, billingError);
        } else {
          console.log(`✅ Registro de billing creado exitosamente`);
        }
      } else {
        console.log(`ℹ️ El sitio ${site_id} ya tiene un registro de billing`);
      }
    } catch (billingErr) {
      console.error(`❌ Excepción al intentar crear billing:`, billingErr);
      // Continuamos con el setup aunque falle la creación de billing
    }
    
    // Preparar argumentos para el workflow
    const workflowArgs: SiteSetupWorkflowArgs = {
      site_id,
      user_id,
      setup_type: setup_type || 'basic',
      options: {
        enable_analytics: options?.enable_analytics !== false, // default true
        enable_chat: options?.enable_chat !== false, // default true
        enable_leads: options?.enable_leads !== false, // default true
        enable_email_tracking: options?.enable_email_tracking !== false, // default true
        default_timezone: options?.default_timezone || 'UTC',
        default_language: options?.default_language || 'es',
        ...options
      }
    };
    
    // Opciones del workflow
    const workflowOptions = {
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'site-setup-queue',
      workflowId: `site-setup-${site_id}-${Date.now()}`,
      priority: 'medium' as const,
      retryAttempts: 3
    };
    
    console.log(`🔄 Ejecutando workflow siteSetupWorkflow con ID: ${workflowOptions.workflowId}`);
    console.log(`📋 Argumentos del workflow:`, JSON.stringify(workflowArgs, null, 2));
    
    // Obtener la instancia del WorkflowService
    const workflowService = WorkflowService.getInstance();
    
    // Ejecutar el workflow usando el servicio existente
    const result = await workflowService.executeWorkflow(
      'siteSetupWorkflow',
      workflowArgs,
      workflowOptions
    );
    
    if (result.success) {
      console.log(`✅ Workflow de setup del sitio iniciado exitosamente`);
      console.log(`🆔 Workflow ID: ${result.workflowId}`);
      console.log(`🏃 Run ID: ${result.runId}`);
      
      return NextResponse.json(
        { 
          success: true, 
          data: {
            workflow_id: result.workflowId,
            execution_id: result.executionId,
            run_id: result.runId,
            status: result.status,
            site_id: site_id,
            setup_type: workflowArgs.setup_type,
            message: 'Site setup workflow iniciado exitosamente'
          }
        },
        { status: 200 }
      );
    } else {
      console.error(`❌ Error al iniciar workflow de setup del sitio:`, result.error);
      
      return NextResponse.json(
        { 
          success: false, 
          error: {
            code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
            message: result.error?.message || 'Error al ejecutar workflow de setup del sitio'
          }
        },
        { status: 500 }
      );
    }
    
  } catch (error) {
    console.error('❌ Error al procesar la solicitud de setup del sitio:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al procesar la solicitud' 
        } 
      },
      { status: 500 }
    );
  }
}

// Método GET para obtener el estado del workflow de setup
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workflowId = searchParams.get('workflow_id');
    
    if (!workflowId) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'workflow_id is required' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`🔍 Consultando estado del workflow: ${workflowId}`);
    
    // Obtener la instancia del WorkflowService
    const workflowService = WorkflowService.getInstance();
    
    // Obtener el estado del workflow
    const status = await workflowService.getWorkflowStatus(workflowId);
    
    if (status.success) {
      console.log(`📊 Estado del workflow ${workflowId}: ${status.status}`);
      
      return NextResponse.json(
        { 
          success: true, 
          data: {
            workflow_id: status.workflowId,
            run_id: status.runId,
            status: status.status,
            message: `Workflow status: ${status.status}`
          }
        },
        { status: 200 }
      );
    } else {
      console.error(`❌ Error al obtener estado del workflow ${workflowId}:`, status.error);
      
      return NextResponse.json(
        { 
          success: false, 
          error: {
            code: status.error?.code || 'WORKFLOW_STATUS_ERROR',
            message: status.error?.message || 'Error al obtener estado del workflow'
          }
        },
        { status: 500 }
      );
    }
    
  } catch (error) {
    console.error('❌ Error al consultar estado del workflow:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'INTERNAL_SERVER_ERROR', 
          message: 'Error interno del servidor al consultar estado del workflow' 
        } 
      },
      { status: 500 }
    );
  }
} 