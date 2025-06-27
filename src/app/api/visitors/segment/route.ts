import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * API DE SEGMENTACIÓN DE VISITANTES Y CAMPAÑAS
 * 
 * Esta API permite gestionar la segmentación de visitantes y asignar automáticamente
 * segmentos y campañas basados en la URL y reglas definidas.
 * 
 * Funcionalidades:
 * - Asignar segmentos a visitantes y leads
 * - Asignar campañas a visitantes y leads (usando c, campaign o campaign_id)
 * - Validar que las campañas pertenezcan al sitio especificado
 * 
 * Documentación completa: /docs/api/visitors/segment
 */

// Esquema para validar el cuerpo de la solicitud
const segmentSchema = z.object({
  segment_id: z.string().optional(),
  site_id: z.string(),
  url: z.string().url(),
  visitor_id: z.string(),
  lead_id: z.string().optional(),
  // Parámetros de campaña - puede ser c, campaign o campaign_id
  c: z.string().optional(),
  campaign: z.string().optional(),
  campaign_id: z.string().optional()
});

export async function POST(request: NextRequest) {
  console.log("[POST /api/visitors/segment] Starting request processing");
  
  try {
    // Parse and validate request body
    const body = await request.json();
    console.log("[POST /api/visitors/segment] Request body:", body);
    
    const validatedData = segmentSchema.parse(body);
    console.log("[POST /api/visitors/segment] Validated data:", validatedData);

    // Check if site exists
    console.log("[POST /api/visitors/segment] Checking site:", validatedData.site_id);
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', validatedData.site_id)
      .single();

    console.log("[POST /api/visitors/segment] Site check result:", { site, error: siteError });

    if (siteError || !site) {
      console.log("[POST /api/visitors/segment] Site not found or error:", { siteError });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'site_not_found',
            message: `Site with ID ${validatedData.site_id} not found`,
            details: siteError
          }
        },
        { status: 400 }
      );
    }

    // Check if visitor exists
    console.log("[POST /api/visitors/segment] Checking visitor:", validatedData.visitor_id);
    const { data: visitor, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('*')
      .eq('id', validatedData.visitor_id)
      .single();

    console.log("[POST /api/visitors/segment] Visitor check result:", { visitor, error: visitorError });

    if (visitorError || !visitor) {
      console.log("[POST /api/visitors/segment] Visitor not found or error:", { visitorError });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'visitor_not_found',
            message: `Visitor with ID ${validatedData.visitor_id} not found`,
            details: visitorError
          }
        },
        { status: 400 }
      );
    }

    // Determinar el campaign_id desde los parámetros
    const campaignId = validatedData.campaign_id || validatedData.campaign || validatedData.c;
    
    let segment = null;
    let segmentError = null;
    let campaign = null;
    let campaignError = null;

    // Only check segment if segment_id is provided
    if (validatedData.segment_id) {
      console.log("[POST /api/visitors/segment] Checking segment:", validatedData.segment_id);
      const segmentResult = await supabaseAdmin
        .from('segments')
        .select('*')
        .eq('id', validatedData.segment_id)
        .single();

      segment = segmentResult.data;
      segmentError = segmentResult.error;

      console.log("[POST /api/visitors/segment] Segment check result:", {
        segment,
        error: segmentError,
        query: 'SELECT * FROM segments WHERE id = ' + validatedData.segment_id
      });

      if (segmentError || !segment) {
        console.log("[POST /api/visitors/segment] Segment not found or error:", { segmentError });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'segment_not_found',
              message: `Segment with ID ${validatedData.segment_id} not found`,
              details: segmentError
            }
          },
          { status: 400 }
        );
      }
    }

    // Only check campaign if campaign_id is provided
    if (campaignId) {
      console.log("[POST /api/visitors/segment] Checking campaign:", campaignId);
      const campaignResult = await supabaseAdmin
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('site_id', validatedData.site_id) // Asegurar que la campaña pertenece al sitio
        .single();

      campaign = campaignResult.data;
      campaignError = campaignResult.error;

      console.log("[POST /api/visitors/segment] Campaign check result:", {
        campaign,
        error: campaignError,
        query: `SELECT * FROM campaigns WHERE id = '${campaignId}' AND site_id = '${validatedData.site_id}'`
      });

      if (campaignError || !campaign) {
        console.log("[POST /api/visitors/segment] Campaign not found or error:", { campaignError });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'campaign_not_found',
              message: `Campaign with ID ${campaignId} not found for this site`,
              details: campaignError
            }
          },
          { status: 400 }
        );
      }
    }

    // Update visitor with segment and campaign (if provided)
    console.log("[POST /api/visitors/segment] Updating visitor with segment and campaign:", {
      visitor_id: validatedData.visitor_id,
      segment_id: validatedData.segment_id,
      campaign_id: campaignId
    });

    // Preparar los datos para actualizar
    const updateData: any = {
      updated_at: new Date().toISOString()
    };
    
    if (validatedData.segment_id) {
      updateData.segment_id = validatedData.segment_id;
    }
    
    if (campaignId) {
      updateData.campaign_id = campaignId;
    }

    const { data: updatedVisitor, error: updateError } = await supabaseAdmin
      .from('visitors')
      .update(updateData)
      .eq('id', validatedData.visitor_id)
      .select()
      .single();

    console.log("[POST /api/visitors/segment] Visitor update result:", {
      visitor: updatedVisitor,
      error: updateError
    });

    if (updateError) {
      console.error("[POST /api/visitors/segment] Error updating visitor:", {
        error: updateError,
        visitor_id: validatedData.visitor_id,
        segment_id: validatedData.segment_id
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'visitor_update_error',
            message: 'Error updating visitor with segment',
            details: updateError
          }
        },
        { status: 500 }
      );
    }

    // If lead_id is provided, also update lead
    let updatedLead = null;
    if (validatedData.lead_id) {
      console.log("[POST /api/visitors/segment] Updating lead with segment and campaign:", {
        lead_id: validatedData.lead_id,
        segment_id: validatedData.segment_id,
        campaign_id: campaignId
      });

      // Preparar los datos para actualizar el lead
      const leadUpdateData: any = {
        updated_at: new Date().toISOString()
      };
      
      if (validatedData.segment_id) {
        leadUpdateData.segment_id = validatedData.segment_id;
      }
      
      if (campaignId) {
        leadUpdateData.campaign_id = campaignId;
      }

      const { data: leadData, error: leadError } = await supabaseAdmin
        .from('leads')
        .update(leadUpdateData)
        .eq('id', validatedData.lead_id)
        .select()
        .single();

      console.log("[POST /api/visitors/segment] Lead update result:", {
        lead: leadData,
        error: leadError
      });

      if (!leadError) {
        updatedLead = leadData;
      } else {
        console.warn("[POST /api/visitors/segment] Error updating lead:", leadError);
      }
    }

    // Return successful response
    const response = {
      success: true,
      segment_id: validatedData.segment_id,
      segment_name: segment?.name,
      campaign_id: campaignId,
      campaign_title: campaign?.title,
      visitor_id: validatedData.visitor_id,
      lead_id: validatedData.lead_id,
      updated_at: new Date().toISOString()
    };

    console.log("[POST /api/visitors/segment] Returning successful response:", response);
    return NextResponse.json(response);

  } catch (error) {
    console.error("[POST /api/visitors/segment] Unhandled error:", error);
    
    if (error instanceof z.ZodError) {
      console.log("[POST /api/visitors/segment] Validation error:", error.errors);
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
          details: error
        }
      },
      { status: 500 }
    );
  }
}

// Add OPTIONS handler for CORS
export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 204 });
  const origin = request.headers.get('origin') || request.headers.get('referer') || '*';
  
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');
  
  return response;
} 