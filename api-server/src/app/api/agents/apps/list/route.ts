import { NextRequest, NextResponse } from 'next/server';
import { ComposioService } from '@/lib/services/composio-service';

/**
 * GET /api/agents/apps/list
 * Retrieves a list of available apps from Composio
 */
export async function GET(req: NextRequest) {
  console.log('[API] Starting Composio apps list request');
  
  // Try to get API key from multiple sources
  const apiKey = process.env.COMPOSIO_PROJECT_API_KEY || 
                 process.env.NEXT_PUBLIC_COMPOSIO_PROJECT_API_KEY || 
                 'du48sq2qy07vkyhm8v9v8g'; // Fallback to hardcoded value if not set
  
  console.log(`[API] API Key available: ${!!apiKey}`);
  console.log(`[API] API Key length: ${apiKey?.length || 0}`);
  console.log(`[API] Environment mode: ${process.env.NODE_ENV}`);
  
  if (!apiKey) {
    console.error('[API] Missing Composio API Key in environment variables');
    // Return mock data in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log('[API] Returning mock data for development');
      return NextResponse.json({
        success: true,
        data: [
          {
            id: 'mock-app-1',
            name: 'Mock App 1',
            description: 'This is a mock app for development',
            appName: 'Mock App',
            appId: 'mock-app-1',
            enabled: true,
            authScheme: 'oauth2',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 'mock-app-2',
            name: 'Mock App 2',
            description: 'Another mock app for development',
            appName: 'Mock App 2',
            appId: 'mock-app-2',
            enabled: true,
            authScheme: 'api_key',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        mock: true,
        note: 'Using mock data because COMPOSIO_PROJECT_API_KEY is not configured'
      });
    }
    
    return NextResponse.json(
      {
        success: false,
        error: 'Composio API Key is not configured in server environment',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
  
  try {
    // Fetch apps from Composio API
    console.log('[API] Calling ComposioService.getIntegrations()');
    const apps = await ComposioService.getIntegrations();
    console.log(`[API] Successfully retrieved ${apps ? apps.length : 0} apps`);
    
    // Return success response with apps data
    console.log('[API] Returning success response');
    return NextResponse.json({
      success: true,
      data: apps
    });
  } catch (error: any) {
    console.error('[API] Error fetching Composio apps:', error);
    console.error('[API] Error details:', error.message);
    console.error('[API] Stack trace:', error.stack);
    
    // Return mock data in development mode for certain errors
    if (process.env.NODE_ENV === 'development' && error.message.includes('API key')) {
      console.log('[API] Returning mock data for development due to API key error');
      return NextResponse.json({
        success: true,
        data: [
          {
            id: 'mock-app-1',
            name: 'Mock App 1',
            description: 'This is a mock app for development',
            appName: 'Mock App',
            appId: 'mock-app-1',
            enabled: true,
            authScheme: 'oauth2',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: 'mock-app-2',
            name: 'Mock App 2',
            description: 'Another mock app for development',
            appName: 'Mock App 2',
            appId: 'mock-app-2',
            enabled: true,
            authScheme: 'api_key',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        mock: true,
        note: 'Using mock data because of an API key configuration error'
      });
    }
    
    // Return error response
    console.log('[API] Returning error response');
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch apps',
        timestamp: new Date().toISOString(),
        apiKeyAvailable: !!process.env.COMPOSIO_PROJECT_API_KEY,
      },
      { status: 500 }
    );
  }
} 