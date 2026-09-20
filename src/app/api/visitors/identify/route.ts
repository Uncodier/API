import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/database/supabase-client'
import { extractRequestInfoWithLocation } from '@/lib/utils/request-info-extractor'
import { identifySchema } from './types'
import { LeadIdentificationService } from '@/lib/services/leads/LeadIdentificationService'
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit'
import { canAccessSite } from '@/lib/security/site-access'
import {
  verifyVisitorSessionToken,
  visitorSessionTokenFromRequest,
} from '@/lib/security/visitor-session-token'

/**
 * API DE IDENTIFICACIÓN DE VISITANTES
 * 
 * Esta API permite vincular un visitante anónimo con información de identificación conocida,
 * como un ID de lead, correo electrónico o cualquier otro identificador personalizado.
 */

export async function POST(request: NextRequest) {
  console.log("[POST /api/visitors/identify] Starting request processing");
  
  try {
    const body = await request.json();
    const validatedData = identifySchema.parse(body);
    const authorized = hasAuthenticatedPrincipal(request)
      ? await canAccessSite(request, validatedData.site_id)
      : await verifyVisitorSessionToken(
          visitorSessionTokenFromRequest(request),
          {
            siteId: validatedData.site_id,
            sessionId: validatedData.session_id,
            visitorId: validatedData.id,
          },
        );
    if (!authorized) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'forbidden',
            message: 'Visitor session authorization is required',
          },
        },
        { status: 403 },
      );
    }

    // 1. Verify Site
    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('id, user_id')
      .eq('id', validatedData.site_id)
      .single();

    if (siteError || !site) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: siteError ? 'site_error' : 'site_not_found',
            message: siteError ? 'Error checking site' : 'Site not found',
            details: siteError
          }
        },
        { status: siteError ? 500 : 400 }
      );
    }

    // 2. Verify the visitor belongs to this active site session.
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('visitor_sessions')
      .select('id')
      .eq('id', validatedData.session_id)
      .eq('site_id', validatedData.site_id)
      .eq('visitor_id', validatedData.id)
      .eq('is_active', true)
      .maybeSingle();
    if (sessionError || !session) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'visitor_session_not_found',
            message: 'Visitor session was not found or is inactive',
          },
        },
        { status: 400 },
      );
    }
    const { data: visitor, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('id', validatedData.id)
      .single();

    if (visitorError || !visitor) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: visitorError?.code === 'PGRST116' ? 'visitor_not_found' : 'visitor_error',
            message: 'Visitor not found',
            details: visitorError
          }
        },
        { status: 400 }
      );
    }

    // 3. Process Lead (Atomic Upsert)
    const lead = await LeadIdentificationService.identifyLead(validatedData, site.user_id);

    if (!lead || !lead.id) {
      throw new Error('Failed to process lead information');
    }

    // 4. Update Visitor and Handle Merges
    const { updatedVisitor, relatedVisitorCount } = await LeadIdentificationService.updateVisitorAndMerge(
      validatedData.id,
      lead.id,
      validatedData.segment_id,
      validatedData.site_id,
    );

    // Extra logging (optional)
    await extractRequestInfoWithLocation(request);

    return NextResponse.json({
      success: true,
      id: updatedVisitor.id,
      lead_id: lead.id,
      segment_id: updatedVisitor.segment_id,
      merged: relatedVisitorCount > 0,
      merged_count: relatedVisitorCount,
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

export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 204 });
  const origin = request.headers.get('origin') || request.headers.get('referer') || '*';
  
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-SA-API-KEY, X-Visitor-Session-Token, Accept, Origin, X-Requested-With');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');
  
  return response;
}
