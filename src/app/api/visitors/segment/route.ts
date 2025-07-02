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
  campaign_id: z.string().optional(),
  // Parámetros de experimento - puede ser e, experiment o experiment_id
  e: z.string().optional(),
  experiment: z.string().optional(),
  experiment_id: z.string().optional()
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
    
    // Determinar el experiment_id desde los parámetros
    const experimentId = validatedData.experiment_id || validatedData.experiment || validatedData.e;
    
    let segment = null;
    let segmentError = null;
    let campaign = null;
    let campaignError = null;
    let experiment = null;
    let experimentError = null;

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

    // Only check experiment if experiment_id is provided
    if (experimentId) {
      console.log("[POST /api/visitors/segment] Checking experiment:", experimentId);
      const experimentResult = await supabaseAdmin
        .from('experiments')
        .select('*')
        .eq('id', experimentId)
        .eq('site_id', validatedData.site_id) // Asegurar que el experimento pertenece al sitio
        .single();

      experiment = experimentResult.data;
      experimentError = experimentResult.error;

      console.log("[POST /api/visitors/segment] Experiment check result:", {
        experiment,
        error: experimentError,
        query: `SELECT * FROM experiments WHERE id = '${experimentId}' AND site_id = '${validatedData.site_id}'`
      });

      if (experimentError || !experiment) {
        console.log("[POST /api/visitors/segment] Experiment not found or error:", { experimentError });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'experiment_not_found',
              message: `Experiment with ID ${experimentId} not found for this site`,
              details: experimentError
            }
          },
          { status: 400 }
        );
      }
    }

    // Update visitor with segment, campaign and experiment (if provided)
    console.log("[POST /api/visitors/segment] Updating visitor with segment, campaign and experiment:", {
      visitor_id: validatedData.visitor_id,
      segment_id: validatedData.segment_id,
      campaign_id: campaignId,
      experiment_id: experimentId
    });

    let updatedVisitor = visitor; // Use existing visitor data as default

    // Only update visitor if there are actual changes to make
    const hasVisitorUpdates = validatedData.segment_id || campaignId || experimentId;
    
    if (hasVisitorUpdates) {
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
      
      if (experimentId) {
        updateData.experiment_id = experimentId;
      }

      const { data: visitorData, error: updateError } = await supabaseAdmin
        .from('visitors')
        .update(updateData)
        .eq('id', validatedData.visitor_id)
        .select()
        .single();

      console.log("[POST /api/visitors/segment] Visitor update result:", {
        visitor: visitorData,
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
      
      updatedVisitor = visitorData;
          } else {
        console.log("[POST /api/visitors/segment] No visitor updates needed - segment_id, campaign_id and experiment_id are all undefined");
      }

    // If lead_id is provided, also update lead
    let updatedLead = null;
    if (validatedData.lead_id) {
      console.log("[POST /api/visitors/segment] Updating lead with segment, campaign and experiment:", {
        lead_id: validatedData.lead_id,
        segment_id: validatedData.segment_id,
        campaign_id: campaignId,
        experiment_id: experimentId
      });

      // Only update lead if there are actual changes to make
      const hasLeadUpdates = validatedData.segment_id || campaignId || experimentId;
      
      if (hasLeadUpdates) {
        // First check if lead exists
        console.log("[POST /api/visitors/segment] Checking if lead exists:", validatedData.lead_id);
        const { data: existingLead, error: leadCheckError } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('id', validatedData.lead_id)
          .maybeSingle();

        console.log("[POST /api/visitors/segment] Lead existence check result:", {
          exists: !!existingLead,
          error: leadCheckError
        });

        if (leadCheckError) {
          console.error("[POST /api/visitors/segment] Error checking lead existence:", leadCheckError);
        } else if (existingLead) {
          // Lead exists, proceed with update
          const leadUpdateData: any = {
            updated_at: new Date().toISOString()
          };
          
          if (validatedData.segment_id) {
            leadUpdateData.segment_id = validatedData.segment_id;
          }
          
          if (campaignId) {
            leadUpdateData.campaign_id = campaignId;
          }
          
          if (experimentId) {
            leadUpdateData.experiment_id = experimentId;
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
        } else {
          console.warn("[POST /api/visitors/segment] Lead not found, skipping update:", validatedData.lead_id);
        }
      } else {
        console.log("[POST /api/visitors/segment] No lead updates needed - segment_id, campaign_id and experiment_id are all undefined");
      }
    }

    // Return successful response
    const response = {
      success: true,
      segment_id: validatedData.segment_id,
      segment_name: segment?.name,
      campaign_id: campaignId,
      campaign_title: campaign?.title,
      experiment_id: experimentId,
      experiment_name: experiment?.name,
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