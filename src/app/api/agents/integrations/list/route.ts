import { NextRequest, NextResponse } from 'next/server';
import { ComposioService, getComposioApiKeyForSite } from '@/lib/services/composio-service';

/**
 * GET /api/agents/integrations/list
 * Retrieves a list of available integrations from Composio
 */
export async function GET(req: NextRequest) {
  console.log('[API] Starting Composio integrations list request');
  
  // Extract site_id
  let site_id = req.nextUrl.searchParams.get('site_id') || req.headers.get('x-site-id');
  
  if (!site_id) {
    try {
      const apiKeyDataStr = req.headers.get('x-api-key-data');
      if (apiKeyDataStr) {
        const apiKeyData = JSON.parse(apiKeyDataStr);
        if (apiKeyData.site_id) {
          site_id = apiKeyData.site_id;
        }
      }
    } catch (e) {
      console.warn('[API] Failed to parse x-api-key-data', e);
    }
  }

  if (!site_id) {
    console.error('[API] Missing site_id in request');
    return NextResponse.json(
      {
        success: false,
        error: 'site_id is required',
        timestamp: new Date().toISOString()
      },
      { status: 400 }
    );
  }
  
  // Try to get API key from site_secrets
  const apiKey = await getComposioApiKeyForSite(site_id);
  
  console.log(`[API] API Key available: ${!!apiKey}`);
  console.log(`[API] API Key length: ${apiKey?.length || 0}`);
  console.log(`[API] Environment mode: ${process.env.NODE_ENV}`);
  
  if (!apiKey) {
    console.error('[API] Missing Composio API Key for site');
    return NextResponse.json(
      {
        success: false,
        error: 'Composio API Key is not configured for this site. Please configure it in Integrations settings.',
        timestamp: new Date().toISOString()
      },
      { status: 401 }
    );
  }
  
  try {
    // Fetch integrations from Composio API
    console.log('[API] Calling ComposioService.getIntegrations()');
    const integrations = await ComposioService.getIntegrations(apiKey);
    console.log(`[API] Successfully retrieved ${integrations ? integrations.length : 0} integrations`);
    
    // Return success response with integrations data
    console.log('[API] Returning success response');
    return NextResponse.json({
      success: true,
      data: integrations
    });
  } catch (error: any) {
    console.error('[API] Error fetching Composio integrations:', error);
    console.error('[API] Error details:', error.message);
    console.error('[API] Stack trace:', error.stack);
    
    // Return error response
    console.log('[API] Returning error response');
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch integrations',
        timestamp: new Date().toISOString(),
        apiKeyAvailable: !!apiKey,
      },
      { status: 500 }
    );
  }
} 