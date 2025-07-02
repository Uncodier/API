import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'
import { manageLeadCreation } from '@/lib/services/leads/lead-service'

export const dynamic = 'force-dynamic';

/**
 * API para asociar un lead a una sesión de visitante
 * 
 * Este endpoint permite identificar a un visitante como un lead,
 * asociando su información de contacto y otros datos relevantes
 * a la sesión en curso.
 */

// Esquema para validar identificación de lead
const IdentifyLeadSchema = z.object({
  lead_id: z.string().uuid("lead_id debe ser un UUID válido").optional(),
  lead_data: z.record(z.any()).optional(),
  name: z.string().optional(),
  email: z.string().email("Email no válido").optional(),
  phone: z.string().optional(),
  create_task: z.boolean().optional().default(false)
}).refine(data => {
  // Función helper para verificar si un campo tiene valor (no vacío)
  const hasValue = (field: string | undefined) => field && field.trim().length > 0;
  
  // Debe proporcionarse lead_id O al menos uno de: nombre, email, teléfono (no vacíos)
  return hasValue(data.lead_id) || hasValue(data.name) || hasValue(data.email) || hasValue(data.phone);
}, {
  message: "Debe proporcionar lead_id o al menos uno de: nombre, email o teléfono del lead"
});

// Función auxiliar para generar respuesta de error
function errorResponse(message: string, status: number = 400, details: any = null) {
  return NextResponse.json({
    success: false,
    error: {
      code: status === 404 ? 'not_found' : 'bad_request',
      message,
      details,
      request_id: uuidv4()
    }
  }, { status });
}

/**
 * Valida y procesa un lead existente cuando se proporciona lead_id
 */
async function processExistingLead(leadId: string, siteId: string): Promise<{
  isValid: boolean;
  lead?: any;
  statusUpdated?: boolean;
  taskCreated?: string | null;
  error?: string;
}> {
  try {
    // 1. Validar que el lead existe y pertenece al site_id
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('site_id', siteId)
      .single();

    if (leadError || !lead) {
      return {
        isValid: false,
        error: 'Lead no encontrado o no pertenece al sitio especificado'
      };
    }

    console.log(`✅ Lead validado: ${leadId}, status actual: ${lead.status}`);

    let statusUpdated = false;
    let taskCreated = null;

    // 2. Si el lead tiene status 'new', cambiarlo a 'qualified'
    if (lead.status === 'new') {
      console.log(`🔄 Actualizando status de lead de 'new' a 'qualified'`);
      
      const { error: updateError } = await supabaseAdmin
        .from('leads')
        .update({ 
          status: 'qualified',
          updated_at: new Date().toISOString()
        })
        .eq('id', leadId);

      if (updateError) {
        console.error('Error al actualizar status del lead:', updateError);
        return {
          isValid: false,
          error: `Error al actualizar status del lead: ${updateError.message}`
        };
      }

      statusUpdated = true;
      lead.status = 'qualified'; // Actualizar objeto local para respuesta
      console.log(`✅ Status del lead actualizado a 'qualified'`);
    }

    // 3. Verificar si el lead tiene tareas en "consideration" y crear una de "website visit" si no tiene ninguna
    const { data: existingConsiderationTasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id')
      .eq('lead_id', leadId)
      .eq('stage', 'consideration')
      .limit(1);

    if (tasksError) {
      console.error('Error al verificar tareas en consideration existentes:', tasksError);
      // No fallar por esto, continuar sin crear tarea
    } else if (!existingConsiderationTasks || existingConsiderationTasks.length === 0) {
      console.log(`📋 Lead no tiene tareas en consideration, creando tarea de website visit en consideration`);
      
      // Crear tarea de website visit en consideration
      const taskData = {
        title: `Website Visit - ${lead.name || lead.email || 'Visitor'}`,
        description: `Automated task created for website visit identification. Lead visited the website and was identified in session.`,
        type: 'website_visit',
        status: 'active',
        stage: 'consideration',
        priority: 1,
        user_id: lead.user_id,
        site_id: lead.site_id,
        lead_id: leadId,
        scheduled_date: new Date().toISOString(), // Programada para ahora
        notes: `Auto-created task for website visit identification. Session-based lead identification.`
      };

      const { data: newTask, error: taskError } = await supabaseAdmin
        .from('tasks')
        .insert([taskData])
        .select()
        .single();

      if (taskError) {
        console.error('Error al crear tarea de website visit:', taskError);
        // No fallar por esto, continuar sin crear tarea
      } else {
        taskCreated = newTask.id;
        console.log(`✅ Tarea de website visit creada: ${newTask.id}`);
      }
    } else {
      console.log(`ℹ️ Lead ya tiene tareas en consideration, no se creará nueva tarea`);
    }

    return {
      isValid: true,
      lead,
      statusUpdated,
      taskCreated
    };

  } catch (error: any) {
    console.error('Error al procesar lead existente:', error);
    return {
      isValid: false,
      error: `Error interno al procesar lead: ${error.message}`
    };
  }
}

/**
 * POST /api/visitors/session/{session_id}/identify
 * 
 * Identifica un lead y lo asocia a una sesión
 */
export async function POST(request: NextRequest) {
  try {
    // Extraer session_id de la URL
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const sessionIndex = pathSegments.findIndex(segment => segment === 'session') + 1;
    const sessionId = pathSegments[sessionIndex];
    
    // Verificar API key en el encabezado
    const apiKey = request.headers.get('X-SA-API-KEY');
    if (!apiKey) {
      return errorResponse('API Key no proporcionada', 401);
    }
    
    // TODO: Validar API key contra la base de datos
    
    // Validar el ID de sesión en la URL
    if (!sessionId) {
      return errorResponse('ID de sesión no proporcionado', 400);
    }
    
    // Obtener el site_id de los parámetros de la consulta
    const siteId = url.searchParams.get('site_id');
    if (!siteId) {
      return errorResponse('site_id es requerido como parámetro de consulta', 400);
    }
    
    // Validar el cuerpo de la solicitud
    const body = await request.json();
    const validationResult = IdentifyLeadSchema.safeParse(body);
    
    if (!validationResult.success) {
      return errorResponse('Datos de solicitud inválidos', 400, validationResult.error.format());
    }
    
    const identifyData = validationResult.data;
    const startTime = Date.now();
    
    // Verificar que la sesión existe
    const { data: session, error: findError } = await supabaseAdmin
      .from('visitor_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .single();
    
    if (findError || !session) {
      return errorResponse('Sesión no encontrada o ha expirado', 404, {
        session_id: sessionId,
        site_id: siteId
      });
    }

    let leadId: string | null = null;
    let isNewLead = false;
    let taskId: string | null = null;
    let statusUpdated = false;

    // Procesar lead basado en si se proporciona lead_id o no
    if (identifyData.lead_id) {
      // Caso: lead_id proporcionado - validar y procesar lead existente
      const leadProcessResult = await processExistingLead(identifyData.lead_id, siteId);
      
      if (!leadProcessResult.isValid) {
        return errorResponse(leadProcessResult.error || 'Error al procesar lead existente', 400);
      }
      
      leadId = identifyData.lead_id;
      isNewLead = false;
      statusUpdated = leadProcessResult.statusUpdated || false;
      taskId = leadProcessResult.taskCreated || null;
      
    } else {
      // Caso: crear o buscar lead basado en información proporcionada
      const leadResult = await manageLeadCreation({
        leadId: identifyData.lead_id,
        name: identifyData.name,
        email: identifyData.email,
        phone: identifyData.phone,
        siteId: siteId,
        visitorId: session.visitor_id,
        origin: 'website_session',
        createTask: identifyData.create_task
      });
      
      leadId = leadResult.leadId;
      isNewLead = leadResult.isNewLead;
      taskId = leadResult.taskId;
    }
    
    if (!leadId) {
      return errorResponse('No se pudo crear o encontrar un lead válido', 400);
    }
    
    // Preparar datos para la actualización
    const updates: any = {
      lead_id: leadId,
      lead_data: identifyData.lead_data || null,
      identified_at: Date.now(),
      updated_at: new Date().toISOString()
    };
    
    // Actualizar la sesión en la base de datos
    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .update(updates)
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .select()
      .single();
    
    if (error) {
      console.error('Error al identificar lead en la sesión:', error);
      return errorResponse(`Error al identificar lead: ${error.message}`, 500);
    }
    
    // Devolver respuesta exitosa
    return NextResponse.json({
      success: true,
      data: {
        session_id: sessionId,
        lead_id: leadId,
        identified_at: updates.identified_at,
        visitor_id: session.visitor_id,
        is_new_lead: isNewLead,
        status_updated: statusUpdated,
        task_id: taskId || null
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime
      }
    });
    
  } catch (error: any) {
    console.error('Error en POST /api/visitors/session/{session_id}/identify:', error);
    return errorResponse(`Error interno del servidor: ${error.message}`, 500);
  }
} 