import { NextRequest, NextResponse } from 'next/server';
import { getSiteAnalysisById } from '@/lib/database/site-analysis-db';

/**
 * GET endpoint to retrieve a specific site analysis by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const id = params.id;
    
    if (!id) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'Analysis ID is required',
          type: 'VALIDATION_ERROR'
        }
      }, { status: 400 });
    }
    
    console.log(`[AnalysisRoute] Retrieving analysis with ID: ${id}`);
    
    const analysis = await getSiteAnalysisById(id);
    
    if (!analysis) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'Analysis not found',
          type: 'NOT_FOUND'
        }
      }, { status: 404 });
    }
    
    return NextResponse.json({
      success: true,
      analysis
    }, { status: 200 });
    
  } catch (error) {
    console.error('Error retrieving site analysis:', error);
    
    return NextResponse.json({
      success: false,
      error: {
        message: 'Error retrieving site analysis',
        type: 'SERVER_ERROR'
      }
    }, { status: 500 });
  }
} 