import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { v4 as uuidv4 } from 'uuid'

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
}).refine((data) => data.lead_id || (data.traits && (data.traits.email || data.traits.phone)), {
  message: "Either lead_id or traits with email/phone must be provided",
  path: ["lead_id", "traits"],
});

// Export the POST handler
export async function POST(request: NextRequest) {
  console.log("[POST /api/visitors/identify] Starting request processing");
  
  try {
    // Parse and validate request body
    const body = await request.json();
    console.log("[POST /api/visitors/identify] Request body:", body);
    
    const validatedData = identifySchema.parse(body);
    console.log("[POST /api/visitors/identify] Validated data:", validatedData);

    // Check if site exists
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
    
    // Primero, veamos la estructura de la tabla
    const { data: tableInfo, error: tableError } = await supabaseAdmin
      .from('visitors')
      .select('*')
      .limit(1);
    
    console.log("[POST /api/visitors/identify] Table structure:", tableInfo ? Object.keys(tableInfo[0] || {}) : 'No data');
    
    // Verificar si el visitante existe en la tabla
    const { data: visitorExists, error: existsError } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('id', validatedData.id)
      .limit(1);
    
    console.log("[POST /api/visitors/identify] Visitor exists check:", { visitorExists, existsError });
    
    // Ahora la consulta del visitante
    const { data: visitor, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('*')
      .eq('id', validatedData.id)
      .single();

    console.log("[POST /api/visitors/identify] Visitor query details:", {
      visitor_id: validatedData.id,
      query_result: visitor,
      error: visitorError,
      error_code: visitorError?.code,
      error_message: visitorError?.message
    });

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

    // Find or create lead
    let lead;
    if (validatedData.lead_id) {
      // If lead_id is provided, try to find the lead
      const { data: existingLead, error: leadError } = await supabaseAdmin
        .from('leads')
        .select('*')
        .eq('id', validatedData.lead_id)
        .single();

      if (leadError && leadError.code !== 'PGRST116') { // PGRST116 is "not found"
        console.error('Error finding lead:', leadError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'lead_error',
              message: 'Error finding lead'
            }
          },
          { status: 500 }
        );
      }

      lead = existingLead;
    } else if (validatedData.traits) {
      // If no lead_id but we have traits, try to find lead by email or phone
      console.log("[POST /api/visitors/identify] Searching for lead with traits:", validatedData.traits);
      
      // Construir filtros para la búsqueda de leads
      let orFilters = [];
      
      if (validatedData.traits.email) {
        orFilters.push(`email.eq."${validatedData.traits.email}"`);
      }
      if (validatedData.traits.phone) {
        orFilters.push(`phone.eq."${validatedData.traits.phone}"`);
      }
      
      console.log("[POST /api/visitors/identify] Lead search query filters:", {
        site_id: validatedData.site_id,
        orFilters,
        email: validatedData.traits?.email,
        phone: validatedData.traits?.phone
      });
      
      // Ejecutar la consulta
      let leadQuery = supabaseAdmin
        .from('leads')
        .select('*')
        .eq('site_id', validatedData.site_id);
      
      if (orFilters.length > 0) {
        leadQuery = leadQuery.or(orFilters.join(','));
      }
      
      const { data: existingLeads, error: searchError } = await leadQuery.limit(1);

      console.log("[POST /api/visitors/identify] Lead search result:", { existingLeads, searchError });

      if (searchError && searchError.code !== 'PGRST116') {
        console.error('[POST /api/visitors/identify] Error searching for lead:', searchError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'lead_search_error',
              message: 'Error searching for lead',
              details: searchError
            }
          },
          { status: 500 }
        );
      }

      if (existingLeads && existingLeads.length > 0) {
        lead = existingLeads[0];
      } else {
        // Create new lead if none found
        const { data: newLead, error: createLeadError } = await supabaseAdmin
          .from('leads')
          .insert([{
            site_id: validatedData.site_id,
            user_id: site.user_id,
            email: validatedData.traits?.email,
            phone: validatedData.traits?.phone,
            name: validatedData.traits?.name,
            position: validatedData.traits?.position,
            status: 'contacted', // Valor por defecto
            notes: '',
            origin: validatedData.traits?.origin || 'website',
            birthday: validatedData.traits?.birthday,
            social_networks: validatedData.traits?.social_networks || {},
            address: validatedData.traits?.address || {},
            company: validatedData.traits?.company || {},
            subscription: validatedData.traits?.subscription || {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }])
          .select()
          .single();

        if (createLeadError) {
          console.error('Error creating lead:', createLeadError);
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'lead_creation_error',
                message: 'Error creating lead',
                details: createLeadError
              }
            },
            { status: 500 }
          );
        }

        lead = newLead;
      }
    }

    // Always update lead traits if provided, regardless of how we found the lead
    if (lead && validatedData.traits) {
      const { data: updatedLead, error: updateLeadError } = await supabaseAdmin
        .from('leads')
        .update({
          email: validatedData.traits.email || lead.email,
          phone: validatedData.traits.phone || lead.phone,
          name: validatedData.traits.name || lead.name,
          position: validatedData.traits.position || lead.position,
          origin: validatedData.traits.origin || lead.origin,
          birthday: validatedData.traits.birthday || lead.birthday,
          social_networks: validatedData.traits.social_networks || lead.social_networks || {},
          address: validatedData.traits.address || lead.address || {},
          company: validatedData.traits.company || lead.company || {},
          subscription: validatedData.traits.subscription || lead.subscription || {},
          updated_at: new Date().toISOString()
        })
        .eq('id', lead.id)
        .select()
        .single();

      if (updateLeadError) {
        console.error('Error updating lead:', updateLeadError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'lead_update_error',
              message: 'Error updating lead',
              details: updateLeadError
            }
          },
          { status: 500 }
        );
      }

      lead = updatedLead;
    }

    // Update visitor with lead information
    const { data: updatedVisitor, error: updateError } = await supabaseAdmin
      .from('visitors')
      .update({
        lead_id: lead?.id,
        is_identified: true,
        updated_at: new Date().toISOString()
      })
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
            message: 'Error updating visitor'
          }
        },
        { status: 500 }
      );
    }

    // Find any other visitors that might need to be merged
    const { data: relatedVisitors, error: relatedError } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('lead_id', lead?.id)
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
      lead_id: lead?.id,
      merged: relatedVisitors.length > 0,
      merged_ids: relatedVisitors.map(v => v.id)
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
          message: 'Internal server error'
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