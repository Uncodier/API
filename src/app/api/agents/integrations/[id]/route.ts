import { NextRequest, NextResponse } from 'next/server';
import { ComposioService, getComposioApiKeyForSite } from '@/lib/services/composio-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/integrations/[id]
 * Retrieves details for a specific integration by ID
 */
export async function GET(request: NextRequest) {
  // Get the id from the path parameter using the URL object
  const url = new URL(request.url);
  const pathSegments = url.pathname.split('/');
  const id = pathSegments[pathSegments.length - 1];
  
  console.log(`[API] Starting Composio integration request for ID: ${id}`);
  
  if (!id) {
    console.error('[API] Missing integration ID in request');
    return NextResponse.json(
      {
        success: false,
        error: 'Integration ID is required',
        timestamp: new Date().toISOString()
      },
      { status: 400 }
    );
  }

  // Extract site_id
  let site_id = url.searchParams.get('site_id') || request.headers.get('x-site-id');
  
  if (!site_id) {
    try {
      const apiKeyDataStr = request.headers.get('x-api-key-data');
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

  // Check if API key is available
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
    // Fetch specific integration from Composio API
    console.log(`[API] Calling ComposioService.getIntegrationById(${id})`);
    const integration = await ComposioService.getIntegrationById(id, apiKey);
    console.log('[API] Successfully retrieved integration details');
    
    // Return success response with integration data
    console.log('[API] Returning success response');
    return NextResponse.json({
      success: true,
      data: integration
    });
  } catch (error: any) {
    console.error(`[API] Error fetching Composio integration ${id}:`, error);
    console.error('[API] Error details:', error.message);
    console.error('[API] Stack trace:', error.stack);
    
    // Return error response
    console.log('[API] Returning error response');
    return NextResponse.json(
      {
        success: false,
        error: error.message || `Failed to fetch integration with ID: ${id}`,
        timestamp: new Date().toISOString(),
        apiKeyAvailable: !!apiKey,
      },
      { status: 500 }
    );
  }
} 