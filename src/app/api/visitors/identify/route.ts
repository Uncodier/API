import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { extractRequestInfo, extractRequestInfoWithLocation, detectScreenSize } from '@/lib/utils/request-info-extractor'

/**
 * API DE IDENTIFICACIÓN DE VISITANTES
 * 
 * Esta API permite vincular un visitante anónimo con información de identificación conocida,
 * como un ID de lead, correo electrónico o cualquier otro identificador personalizado.
 * 
 * Documentación completa: /docs/api/visitors/identify
 */

// Validation schema for the request body
const identifySchema = z.object({
  site_id: z.string(),
  id: z.string(),
  lead_id: z.string().optional(),
  segment_id: z.string().optional(),
  traits: z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    name: z.string().optional(),
    position: z.string().optional(),
    birthday: z.string().optional(),
    origin: z.string().optional(),
    social_networks: z.record(z.string()).optional(),
    address: z.object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional()
    }).optional(),
    company: z.object({
      name: z.string().optional(),
      industry: z.string().optional(),
      employee_count: z.number().optional()
    }).optional(),
    subscription: z.object({
      plan: z.string().optional(),
      status: z.string().optional(),
      started_at: z.string().optional()
    }).optional()
  }).optional(),
  timestamp: z.number().optional(),
}).refine((data) => data.lead_id || (data.traits && (data.traits.email || data.traits.phone || data.traits.name)), {
  message: "Either lead_id or traits with email/phone/name must be provided",
  path: ["lead_id", "traits"],
});

/**
 * Busca un lead existente por email, phone o name
 */
async function findExistingLead(
  siteId: string, 
  email?: string, 
  phone?: string, 
  name?: string
): Promise<any | null> {
  if (!email && !phone && !name) {
    return null;
  }

  let orFilters: string[] = [];
  
  if (email) orFilters.push(`email.eq."${email}"`);
  if (phone) orFilters.push(`phone.eq."${phone}"`);
  if (name) orFilters.push(`name.eq."${name}"`);
  
  const { data: leads, error } = await supabaseAdmin
    .from('leads')
    .select('*')
    .eq('site_id', siteId)
    .or(orFilters.join(','))
    .limit(1);

  if (error) {
    console.error('[findExistingLead] Error searching for lead:', error);
    throw error;
  }

  return leads && leads.length > 0 ? leads[0] : null;
}

/**
 * Crea un nuevo lead
 */
async function createNewLead(siteId: string, userIdFromSite: string, traits: any): Promise<any> {
  const { data: newLead, error } = await supabaseAdmin
    .from('leads')
    .insert([{
      site_id: siteId,
      user_id: userIdFromSite,
      email: traits?.email,
      phone: traits?.phone,
      name: traits?.name,
      position: traits?.position,
      status: 'contacted',
      notes: '',
      origin: traits?.origin || 'website',
      birthday: traits?.birthday,
      social_networks: traits?.social_networks || {},
      address: traits?.address || {},
      company: traits?.company || {},
      subscription: traits?.subscription || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) {
    console.error('[createNewLead] Error creating lead:', error);
    throw error;
  }

  return newLead;
}

/**
 * Actualiza los datos de un lead existente
 */
async function updateLeadIfNeeded(lead: any, traits: any): Promise<any> {
  if (!traits) {
    return lead;
  }

  // Verificar qué campos necesitan actualización
  const updatedFields: any = {};
  let needsUpdate = false;

  if (traits.email && traits.email !== lead.email) {
    updatedFields.email = traits.email;
    needsUpdate = true;
  }
  if (traits.phone && traits.phone !== lead.phone) {
    updatedFields.phone = traits.phone;
    needsUpdate = true;
  }
  if (traits.name && traits.name !== lead.name) {
    updatedFields.name = traits.name;
    needsUpdate = true;
  }
  if (traits.position && traits.position !== lead.position) {
    updatedFields.position = traits.position;
    needsUpdate = true;
  }
  if (traits.origin && traits.origin !== lead.origin) {
    updatedFields.origin = traits.origin;
    needsUpdate = true;
  }
  if (traits.birthday && traits.birthday !== lead.birthday) {
    updatedFields.birthday = traits.birthday;
    needsUpdate = true;
  }
  if (traits.social_networks && JSON.stringify(traits.social_networks) !== JSON.stringify(lead.social_networks)) {
    updatedFields.social_networks = traits.social_networks;
    needsUpdate = true;
  }
  if (traits.address && JSON.stringify(traits.address) !== JSON.stringify(lead.address)) {
    updatedFields.address = traits.address;
    needsUpdate = true;
  }
  if (traits.company && JSON.stringify(traits.company) !== JSON.stringify(lead.company)) {
    updatedFields.company = traits.company;
    needsUpdate = true;
  }
  if (traits.subscription && JSON.stringify(traits.subscription) !== JSON.stringify(lead.subscription)) {
    updatedFields.subscription = traits.subscription;
    needsUpdate = true;
  }

  if (!needsUpdate) {
    return lead;
  }

  updatedFields.updated_at = new Date().toISOString();

  const { data: updatedLead, error } = await supabaseAdmin
    .from('leads')
    .update(updatedFields)
    .eq('id', lead.id)
    .select()
    .single();

  if (error) {
    console.error('[updateLeadIfNeeded] Error updating lead:', error);
    throw error;
  }

  return updatedLead;
}

// Export the POST handler
export async function POST(request: NextRequest) {
  console.log("[POST /api/visitors/identify] Starting request processing");
  
  try {
    // Parse and validate request body
    const body = await request.json();
    console.log("[POST /api/visitors/identify] Request body:", body);
    
    const validatedData = identifySchema.parse(body);
    console.log("[POST /api/visitors/identify] Validated data:", validatedData);

    // Check if site exists and get user_id
    console.log("[POST /api/visitors/identify] Checking site existence:", validatedData.site_id);
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', validatedData.site_id)
      .single();

    console.log("[POST /api/visitors/identify] Site query result:", { site, siteError });

    if (siteError) {
      console.log("[POST /api/visitors/identify] Site error:", siteError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'site_error',
            message: 'Error checking site',
            details: siteError
          }
        },
        { status: 500 }
      );
    }

    if (!site) {
      console.log("[POST /api/visitors/identify] Site not found:", validatedData.site_id);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'site_not_found',
            message: `Site with ID ${validatedData.site_id} not found. Please create the site first using the /api/visitors/sites endpoint.`,
            details: {
              site_id: validatedData.site_id,
              required_action: 'create_site'
            }
          }
        },
        { status: 400 }
      );
    }

    // Check if visitor exists
    console.log("[POST /api/visitors/identify] Checking visitor existence:", validatedData.id);
    const { data: visitor, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('*')
      .eq('id', validatedData.id)
      .single();

    console.log("[POST /api/visitors/identify] Visitor query result:", { visitor, visitorError });

    if (visitorError) {
      console.log("[POST /api/visitors/identify] Visitor error:", visitorError);
      if (visitorError.code === 'PGRST116') {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'visitor_not_found',
              message: `Visitor with ID ${validatedData.id} not found. Please track the visitor first using the /api/visitors/track endpoint.`,
              details: {
                visitor_id: validatedData.id,
                required_action: 'track_visitor'
              }
            }
          },
          { status: 400 }
        );
      }
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'visitor_error',
            message: 'Error checking visitor',
            details: visitorError
          }
        },
        { status: 500 }
      );
    }

    if (!visitor) {
      console.log("[POST /api/visitors/identify] Visitor not found:", validatedData.id);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'visitor_not_found',
            message: `Visitor with ID ${validatedData.id} not found. Please track the visitor first using the /api/visitors/track endpoint.`,
            details: {
              visitor_id: validatedData.id,
              required_action: 'track_visitor'
            }
          }
        },
        { status: 400 }
      );
    }

    // Gestión de leads según las especificaciones
    let lead: any = null;

    if (validatedData.lead_id) {
      // 1. Si viene con lead_id, buscarlo y actualizar sus datos
      console.log("[POST /api/visitors/identify] Finding lead by ID:", validatedData.lead_id);
      
      const { data: existingLead, error: leadError } = await supabaseAdmin
        .from('leads')
        .select('*')
        .eq('id', validatedData.lead_id)
        .single();

      if (leadError) {
        if (leadError.code === 'PGRST116') {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'lead_not_found',
                message: `Lead with ID ${validatedData.lead_id} not found.`,
                details: {
                  lead_id: validatedData.lead_id
                }
              }
            },
            { status: 400 }
          );
        }
        throw leadError;
      }

      // Actualizar el lead si es necesario
      lead = await updateLeadIfNeeded(existingLead, validatedData.traits);
      console.log("[POST /api/visitors/identify] Lead found and updated:", lead.id);

    } else {
      // 2. Si no viene con lead_id, buscarlo por cualquiera de los parámetros
      console.log("[POST /api/visitors/identify] Searching for existing lead with traits:", validatedData.traits);
      
      lead = await findExistingLead(
        validatedData.site_id,
        validatedData.traits?.email,
        validatedData.traits?.phone,
        validatedData.traits?.name
      );

      if (lead) {
        // Lead encontrado, actualizar si es necesario
        lead = await updateLeadIfNeeded(lead, validatedData.traits);
        console.log("[POST /api/visitors/identify] Existing lead found and updated:", lead.id);
      } else {
        // Lead no encontrado, crear uno nuevo
        console.log("[POST /api/visitors/identify] Creating new lead");
        lead = await createNewLead(validatedData.site_id, site.user_id, validatedData.traits);
        console.log("[POST /api/visitors/identify] New lead created:", lead.id);
      }
    }

    // 3. Traer el lead_id para terminar el proceso
    if (!lead || !lead.id) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'lead_processing_error',
            message: 'Failed to process lead information'
          }
        },
        { status: 500 }
      );
    }

    // Extraer información automáticamente de la petición si no está presente en el visitante
    const requestInfo = await extractRequestInfoWithLocation(request);
    console.log(`[POST /api/visitors/identify] Información extraída de la petición:`, requestInfo);

    // Preparar datos de actualización del visitante
    const visitorUpdateData: any = {
      lead_id: lead.id,
      segment_id: validatedData.segment_id,
      is_identified: true,
      updated_at: new Date().toISOString()
    };

    // Nota: La información de dispositivo se guarda solo en visitor_sessions
    // ya que un visitante puede tener múltiples sesiones desde diferentes dispositivos

    // Nota: La información de navegador se guarda solo en visitor_sessions
    // ya que un visitante puede tener múltiples sesiones desde diferentes navegadores

    // La información de ubicación se puede mantener como está por ahora
    // ya que requeriría un servicio de geolocalización por IP

    console.log(`[POST /api/visitors/identify] Datos de actualización del visitante:`, {
      ...visitorUpdateData,
      // device y browser se guardan solo en visitor_sessions
    });

    // Update visitor with lead information and enhanced data
    const { data: updatedVisitor, error: updateError } = await supabaseAdmin
      .from('visitors')
      .update(visitorUpdateData)
      .eq('id', validatedData.id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating visitor:', updateError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'visitor_update_error',
            message: 'Error updating visitor',
            details: updateError
          }
        },
        { status: 500 }
      );
    }

    // Find any other visitors that might need to be merged
    const { data: relatedVisitors, error: relatedError } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('lead_id', lead.id)
      .neq('id', validatedData.id);

    if (relatedError) {
      console.error('Error finding related visitors:', relatedError);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'related_visitors_error',
            message: 'Error finding related visitors'
          }
        },
        { status: 500 }
      );
    }

    // Devolvemos una respuesta exitosa con información sobre el visitante y el lead asociado
    return NextResponse.json({
      success: true,
      id: updatedVisitor.id,
      lead_id: lead.id,
      segment_id: updatedVisitor.segment_id,
      merged: relatedVisitors.length > 0,
      merged_ids: relatedVisitors.map((v: any) => v.id)
    });

  } catch (error) {
    console.error('Error in identify endpoint:', error);
    
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
  console.log("[OPTIONS /api/visitors/identify] Handling CORS preflight request");
  
  // Create a new response with 204 status
  const response = new NextResponse(null, { status: 204 });
  
  // Get the origin from the request
  const origin = request.headers.get('origin') || request.headers.get('referer') || 'http://192.168.87.25:3001';
  console.log("[OPTIONS /api/visitors/identify] Using origin for CORS:", origin);
  
  // Add CORS headers
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400'); // 24 hours
  
  console.log("[OPTIONS /api/visitors/identify] Returning CORS response");
  return response;
} 