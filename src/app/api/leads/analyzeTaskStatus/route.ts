import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * API DE ANÁLISIS DE ESTADO DE TASKS DE LEADS
 * 
 * Esta API analiza el comportamiento de un lead para:
 * 1. Crear un task de tipo "awareness" si tiene visitas al sitio
 * 2. Cambiar el status del lead a "contacted" si tiene conversaciones
 * 
 * Valida que no existan tasks duplicados del mismo tipo.
 */

// Validation schema for the request body
const analyzeTaskStatusSchema = z.object({
  lead_id: z.string().uuid()
});

// Interfaces para los tipos de respuesta
interface ActionTaken {
  action: string;
  task_id?: string;
  previous_status?: string;
  new_status?: string;
  reason: string;
}

interface SkippedAction {
  action: string;
  reason: string;
}

interface AnalysisResults {
  lead_id: string;
  actions_taken: ActionTaken[];
  skipped_actions: SkippedAction[];
}

/**
 * Verifica si el lead tiene visitas al sitio
 */
async function hasVisits(leadId: string): Promise<boolean> {
  console.log(`[hasVisits] Checking visits for lead: ${leadId}`);
  
  const { data: visitors, error } = await supabaseAdmin
    .from('visitors')
    .select('id')
    .eq('lead_id', leadId)
    .limit(1);

  if (error) {
    console.error('[hasVisits] Error checking visitors:', error);
    throw error;
  }

  return visitors && visitors.length > 0;
}

/**
 * Verifica si el lead tiene conversaciones
 */
async function hasConversations(leadId: string): Promise<boolean> {
  console.log(`[hasConversations] Checking conversations for lead: ${leadId}`);
  
  const { data: conversations, error } = await supabaseAdmin
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .limit(1);

  if (error) {
    console.error('[hasConversations] Error checking conversations:', error);
    throw error;
  }

  return conversations && conversations.length > 0;
}

/**
 * Verifica si existe un task de un tipo específico para el lead
 */
async function hasTaskOfType(leadId: string, stage: string): Promise<boolean> {
  console.log(`[hasTaskOfType] Checking task of stage "${stage}" for lead: ${leadId}`);
  
  const { data: tasks, error } = await supabaseAdmin
    .from('tasks')
    .select('id')
    .eq('lead_id', leadId)
    .eq('stage', stage)
    .limit(1);

  if (error) {
    console.error('[hasTaskOfType] Error checking tasks:', error);
    throw error;
  }

  return tasks && tasks.length > 0;
}

/**
 * Crea un task de awareness para el lead
 */
async function createAwarenessTask(leadId: string, siteId: string, userId: string): Promise<any> {
  console.log(`[createAwarenessTask] Creating awareness task for lead: ${leadId}`);
  
  const { data: task, error } = await supabaseAdmin
    .from('tasks')
    .insert([{
      lead_id: leadId,
      site_id: siteId,
      user_id: userId,
      title: 'Lead visitó el sitio web',
      description: 'El lead ha mostrado interés inicial visitando el sitio web. Es momento de hacer seguimiento.',
      type: 'follow_up',
      stage: 'awareness',
      status: 'pending',
      priority: 1,
      scheduled_date: new Date().toISOString(),
      serial_id: `AWARE-${Date.now()}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) {
    console.error('[createAwarenessTask] Error creating awareness task:', error);
    throw error;
  }

  return task;
}

/**
 * Actualiza el status del lead a "contacted"
 */
async function updateLeadToContacted(leadId: string): Promise<any> {
  console.log(`[updateLeadToContacted] Updating lead status to contacted: ${leadId}`);
  
  const { data: lead, error } = await supabaseAdmin
    .from('leads')
    .update({
      status: 'contacted',
      last_contact: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', leadId)
    .select()
    .single();

  if (error) {
    console.error('[updateLeadToContacted] Error updating lead status:', error);
    throw error;
  }

  return lead;
}

// Export the POST handler
export async function POST(request: NextRequest) {
  console.log("[POST /api/leads/analyzeTaskStatus] Starting request processing");
  
  try {
    // Parse and validate request body
    const body = await request.json();
    console.log("[POST /api/leads/analyzeTaskStatus] Request body:", body);
    
    const validatedData = analyzeTaskStatusSchema.parse(body);
    console.log("[POST /api/leads/analyzeTaskStatus] Validated data:", validatedData);

    // Verificar si el lead existe y obtener información del sitio
    console.log("[POST /api/leads/analyzeTaskStatus] Checking lead existence:", validatedData.lead_id);
    const { data: lead, error: leadError } = await supabaseAdmin
      .from('leads')
      .select('id, site_id, user_id, status')
      .eq('id', validatedData.lead_id)
      .single();

    if (leadError) {
      console.log("[POST /api/leads/analyzeTaskStatus] Lead error:", leadError);
      if (leadError.code === 'PGRST116') {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'lead_not_found',
              message: `Lead with ID ${validatedData.lead_id} not found.`
            }
          },
          { status: 404 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'lead_error',
            message: 'Error checking lead',
            details: leadError
          }
        },
        { status: 500 }
      );
    }

    if (!lead) {
      console.log("[POST /api/leads/analyzeTaskStatus] Lead not found:", validatedData.lead_id);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'lead_not_found',
            message: `Lead with ID ${validatedData.lead_id} not found.`
          }
        },
        { status: 404 }
      );
    }

    console.log("[POST /api/leads/analyzeTaskStatus] Lead found:", lead);

    const results: AnalysisResults = {
      lead_id: lead.id,
      actions_taken: [],
      skipped_actions: []
    };

    // 1. Verificar visitas y crear task de awareness si es necesario
    console.log("[POST /api/leads/analyzeTaskStatus] Checking for visits...");
    const leadHasVisits = await hasVisits(lead.id);
    
    if (leadHasVisits) {
      console.log("[POST /api/leads/analyzeTaskStatus] Lead has visits, checking for existing awareness task...");
      const hasAwarenessTask = await hasTaskOfType(lead.id, 'awareness');
      
      if (!hasAwarenessTask) {
        console.log("[POST /api/leads/analyzeTaskStatus] Creating awareness task...");
        const awarenessTask = await createAwarenessTask(lead.id, lead.site_id, lead.user_id);
        results.actions_taken.push({
          action: 'created_awareness_task',
          task_id: awarenessTask.id,
          reason: 'Lead has visits but no awareness task existed'
        });
      } else {
        console.log("[POST /api/leads/analyzeTaskStatus] Awareness task already exists, skipping...");
        results.skipped_actions.push({
          action: 'create_awareness_task',
          reason: 'Awareness task already exists'
        });
      }
    } else {
      console.log("[POST /api/leads/analyzeTaskStatus] Lead has no visits, skipping awareness task...");
      results.skipped_actions.push({
        action: 'create_awareness_task',
        reason: 'Lead has no visits'
      });
    }

    // 2. Verificar conversaciones y actualizar status si es necesario
    console.log("[POST /api/leads/analyzeTaskStatus] Checking for conversations...");
    const leadHasConversations = await hasConversations(lead.id);
    
    if (leadHasConversations) {
      console.log("[POST /api/leads/analyzeTaskStatus] Lead has conversations, checking current status...");
      
      if (lead.status !== 'contacted') {
        console.log("[POST /api/leads/analyzeTaskStatus] Updating lead status to contacted...");
        const updatedLead = await updateLeadToContacted(lead.id);
        results.actions_taken.push({
          action: 'updated_lead_status',
          previous_status: lead.status,
          new_status: 'contacted',
          reason: 'Lead has conversations but status was not contacted'
        });
      } else {
        console.log("[POST /api/leads/analyzeTaskStatus] Lead status already contacted, skipping...");
        results.skipped_actions.push({
          action: 'update_lead_status',
          reason: 'Lead status is already contacted'
        });
      }
    } else {
      console.log("[POST /api/leads/analyzeTaskStatus] Lead has no conversations, skipping status update...");
      results.skipped_actions.push({
        action: 'update_lead_status',
        reason: 'Lead has no conversations'
      });
    }

    console.log("[POST /api/leads/analyzeTaskStatus] Analysis completed:", results);

    return NextResponse.json({
      success: true,
      ...results
    });

  } catch (error) {
    console.error('Error in analyzeTaskStatus endpoint:', error);
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'invalid_parameters',
            message: 'Invalid request parameters',
            details: error.errors
          }
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'internal_error',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      },
      { status: 500 }
    );
  }
}

// Add OPTIONS handler for CORS
export async function OPTIONS(request: NextRequest) {
  console.log("[OPTIONS /api/leads/analyzeTaskStatus] Handling CORS preflight request");
  
  // Create a new response with 204 status
  const response = new NextResponse(null, { status: 204 });
  
  // Get the origin from the request
  const origin = request.headers.get('origin') || request.headers.get('referer') || '*';
  console.log("[OPTIONS /api/leads/analyzeTaskStatus] Using origin for CORS:", origin);
  
  // Add CORS headers
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400'); // 24 hours
  
  console.log("[OPTIONS /api/leads/analyzeTaskStatus] Returning CORS response");
  return response;
} 