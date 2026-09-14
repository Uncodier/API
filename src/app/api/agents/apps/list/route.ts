import { NextRequest, NextResponse } from 'next/server';
import { ComposioService, getComposioApiKeyForSite } from '@/lib/services/composio-service';

/**
 * GET /api/agents/apps/list
 * Retrieves a list of available apps from Composio
 */
export async function GET(req: NextRequest) {
  console.log('[API] Starting Composio apps list request');
  
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
    // Fetch apps from Composio API
    console.log('[API] Calling ComposioService.getIntegrations()');
    const apps = await ComposioService.getIntegrations(apiKey);
    console.log(`[API] Successfully retrieved ${apps ? apps.length : 0} apps`);
    
    // Return success response with apps data
    console.log('[API] Returning success response');
    return NextResponse.json({
      success: true,
      data: apps
    });
  } catch (error: any) {
    const isUnauthorized = error.message && error.message.includes('401 Unauthorized');
    
    if (isUnauthorized) {
      console.warn('[API] Composio API Key is invalid or expired (401 Unauthorized)');
    } else {
      console.error('[API] Error fetching Composio apps:', error);
      console.error('[API] Error details:', error.message);
      console.error('[API] Stack trace:', error.stack);
    }
    
    // Return error response
    if (isUnauthorized) {
      console.log('[API] Returning 401 error response');
      return NextResponse.json(
        {
          success: false,
          error: 'Composio API Key is invalid or expired. Please update it in your environment settings.',
          timestamp: new Date().toISOString(),
          apiKeyAvailable: !!apiKey,
        },
        { status: 401 }
      );
    }
    
    console.log('[API] Returning error response');
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch apps',
        timestamp: new Date().toISOString(),
        apiKeyAvailable: !!apiKey,
      },
      { status: 500 }
    );
  }
} 