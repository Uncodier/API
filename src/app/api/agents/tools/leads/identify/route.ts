import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Endpoint para identificar a un visitante como un lead potencial
 * 
 * @param request Solicitud entrante con los datos del visitante
 * @returns Respuesta con los datos del lead y acciones sugeridas
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extraer parámetros requeridos
    const { 
      visitor_id,
      site_id,
      lead_score,
      source,
      contact_info,
      company_info,
      interest_level,
      product_interest,
      pages_visited,
      time_spent,
      visit_count,
      notes
    } = body;
    
    // Validar parámetros requeridos
    if (!visitor_id || !site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'visitor_id and site_id are required'
        },
        { status: 400 }
      );
    }
    
    // Validar visitor_id y site_id
    if (!isValidUUID(visitor_id) || !isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'visitor_id and site_id must be valid UUIDs'
        },
        { status: 400 }
      );
    }
    
    // Validar score si está presente (debe estar entre 1-100)
    if (lead_score !== undefined && (lead_score < 1 || lead_score > 100)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'lead_score must be between 1 and 100'
        },
        { status: 400 }
      );
    }
    
    // Verificar que el visitante existe
    const { data: visitorData, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('id, site_id')
      .eq('id', visitor_id)
      .single();
    
    if (visitorError) {
      console.error('Error al verificar el visitante:', visitorError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Visitor not found'
        },
        { status: 404 }
      );
    }

    if (visitorData.site_id !== site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'El visitante no pertenece a este sitio'
        },
        { status: 403 }
      );
    }
    
    // Verificar si el visitante ya está identificado como lead
    const { data: existingLead, error: leadCheckError } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('visitor_id', visitor_id)
      .maybeSingle();
    
    if (leadCheckError) {
      console.error('Error al verificar si el lead ya existe:', leadCheckError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error checking existing lead'
        },
        { status: 500 }
      );
    }
    
    if (existingLead) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Visitor already identified as a lead'
        },
        { status: 409 }
      );
    }
    
    // Crear un nuevo lead
    const lead_id = uuidv4();
    const now = new Date().toISOString();
    
    const leadData = {
      id: lead_id,
      visitor_id,
      lead_score: lead_score || 50, // Valor predeterminado si no se proporciona
      source,
      contact_info,
      company_info,
      interest_level,
      product_interest,
      pages_visited,
      time_spent,
      visit_count,
      notes,
      status: 'new',
      created_at: now,
      updated_at: now,
      site_id: visitorData.site_id
    };
    
    const { data: lead, error: insertError } = await supabaseAdmin
      .from('leads')
      .insert([leadData])
      .select()
      .single();
    
    if (insertError) {
      console.error('Error al crear el lead:', insertError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Failed to create lead'
        },
        { status: 500 }
      );
    }
    
    // Generar acciones sugeridas basadas en el perfil del lead
    const nextActions = generateNextActions(lead);
    
    // Respuesta exitosa
    return NextResponse.json(
      {
        success: true,
        lead,
        next_actions: nextActions
      },
      { status: 201 }
    );
    
  } catch (error) {
    console.error('Error al procesar la identificación de lead:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'An error occurred while processing the lead identification'
      },
      { status: 500 }
    );
  }
}

/**
 * Genera acciones sugeridas basadas en el perfil del lead
 */
function generateNextActions(lead: any) {
  const actions = [];
  
  // Añadir acción basada en el nivel de interés
  if (lead.interest_level === 'high') {
    actions.push({
      action_type: 'call',
      priority: 'high',
      description: 'Schedule a sales call to discuss product offerings'
    });
  } else if (lead.interest_level === 'medium') {
    actions.push({
      action_type: 'email',
      priority: 'medium',
      description: 'Send personalized email with relevant product information'
    });
  } else {
    actions.push({
      action_type: 'content',
      priority: 'low',
      description: 'Share educational content related to their industry'
    });
  }
  
  // Añadir acción basada en el score
  if (lead.lead_score >= 80) {
    actions.push({
      action_type: 'demo',
      priority: 'high',
      description: 'Offer product demonstration'
    });
  } else if (lead.lead_score >= 50) {
    actions.push({
      action_type: 'email',
      priority: 'medium',
      description: 'Send case studies relevant to their industry'
    });
  }
  
  // Añadir acción si hay información de contacto completa
  if (lead.contact_info && lead.contact_info.email && lead.contact_info.name) {
    actions.push({
      action_type: 'email',
      priority: 'medium',
      description: 'Send welcome email with resources'
    });
  }
  
  return actions;
} 