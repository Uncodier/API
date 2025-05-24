import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'

/**
 * API DE SEGMENTACIÓN DE VISITANTES
 * 
 * Esta API permite gestionar la segmentación de visitantes y asignar automáticamente
 * segmentos basados en la URL y reglas definidas.
 * 
 * Documentación completa: /docs/api/visitors/segment
 */

// Esquema para validar el cuerpo de la solicitud
const segmentSchema = z.object({
  segment_id: z.string().optional(),
  site_id: z.string(),
  url: z.string().url(),
  visitor_id: z.string(),
  lead_id: z.string().optional()
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

    let segment = null;
    let segmentError = null;

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

    // Update visitor with segment (if provided)
    console.log("[POST /api/visitors/segment] Updating visitor with segment:", {
      visitor_id: validatedData.visitor_id,
      segment_id: validatedData.segment_id
    });

    const { data: updatedVisitor, error: updateError } = await supabaseAdmin
      .from('visitors')
      .update({
        segment_id: validatedData.segment_id,
        updated_at: new Date().toISOString()
      })
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
      console.log("[POST /api/visitors/segment] Updating lead with segment:", {
        lead_id: validatedData.lead_id,
        segment_id: validatedData.segment_id
      });

      const { data: leadData, error: leadError } = await supabaseAdmin
        .from('leads')
        .update({
          segment_id: validatedData.segment_id,
          updated_at: new Date().toISOString()
        })
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
      name: segment?.name,
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