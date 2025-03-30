import { NextRequest, NextResponse } from 'next/server';
import { getSiteAnalysesBySite } from '@/lib/database/site-analysis-db';

/**
 * GET endpoint to retrieve all site analyses for a specific site
 * Requires user_id as a query parameter for authorization
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { siteId: string } }
) {
  try {
    const siteId = params.siteId;
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');
    
    if (!siteId) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'Site ID is required',
          type: 'VALIDATION_ERROR'
        }
      }, { status: 400 });
    }
    
    if (!userId) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'User ID is required as a query parameter',
          type: 'AUTHORIZATION_ERROR'
        }
      }, { status: 401 });
    }
    
    console.log(`[AnalysisRoute] Retrieving analyses for site ID: ${siteId} and user ID: ${userId}`);
    
    const analyses = await getSiteAnalysesBySite(siteId, userId);
    
    return NextResponse.json({
      success: true,
      analyses
    }, { status: 200 });
    
  } catch (error) {
    console.error('Error retrieving site analyses:', error);
    
    return NextResponse.json({
      success: false,
      error: {
        message: 'Error retrieving site analyses',
        type: 'SERVER_ERROR'
      }
    }, { status: 500 });
  }
} 