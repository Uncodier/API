import { NextRequest, NextResponse } from 'next/server';
import { ComposioService } from '@/lib/services/composio-service';

/**
 * GET /api/agents/integrations/[id]
 * Retrieves details for a specific integration by ID
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  
  console.log(`[API] Starting Composio integration request for ID: ${id}`);
  
  // Try to get API key from multiple sources
  const apiKey = process.env.COMPOSIO_PROJECT_API_KEY || 
                 process.env.NEXT_PUBLIC_COMPOSIO_PROJECT_API_KEY || 
                 'du48sq2qy07vkyhm8v9v8g'; // Fallback to hardcoded value if not set
  
  console.log(`[API] API Key available: ${!!apiKey}`);
  console.log(`[API] API Key length: ${apiKey?.length || 0}`);
  console.log(`[API] Environment mode: ${process.env.NODE_ENV}`);

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

  // Check if API key is available
  if (!apiKey) {
    console.error('[API] Missing Composio API Key in environment variables');
    
    // Return mock data in development mode
    if (process.env.NODE_ENV === 'development') {
      console.log('[API] Returning mock data for development');
      return NextResponse.json({
        success: true,
        data: {
          id: id,
          name: `Mock Integration ${id}`,
          description: 'This is a mock integration for development',
          appName: 'Mock App',
          appId: 'mock-app-1',
          enabled: true,
          authScheme: 'oauth2',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          connections: [],
          member: {
            id: 'mock-member-id',
            name: 'Mock User',
            email: 'mock@example.com'
          }
        },
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
    // Fetch specific integration from Composio API
    console.log(`[API] Calling ComposioService.getIntegrationById(${id})`);
    const integration = await ComposioService.getIntegrationById(id);
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
    
    // Return mock data in development mode for certain errors
    if (process.env.NODE_ENV === 'development' && error.message.includes('API key')) {
      console.log('[API] Returning mock data for development due to API key error');
      return NextResponse.json({
        success: true,
        data: {
          id: id,
          name: `Mock Integration ${id}`,
          description: 'This is a mock integration for development',
          appName: 'Mock App',
          appId: 'mock-app-1',
          enabled: true,
          authScheme: 'oauth2',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          connections: [],
          member: {
            id: 'mock-member-id',
            name: 'Mock User',
            email: 'mock@example.com'
          }
        },
        mock: true,
        note: 'Using mock data because of an API key configuration error'
      });
    }
    
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