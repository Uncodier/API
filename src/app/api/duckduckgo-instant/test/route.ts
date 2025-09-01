import { NextRequest, NextResponse } from 'next/server';
import { DuckDuckGoInstantApiService } from '@/lib/services/duckduckgo-instant-api';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || 'hello';
  
  console.log('🧪 [DuckDuckGo Instant Test] Starting API connection test');
  
  try {
    const instantApiService = DuckDuckGoInstantApiService.getInstance();
    const testResult = await instantApiService.testApiConnection(query);
    
    if (testResult.success) {
      console.log('✅ [DuckDuckGo Instant Test] API connection successful');
      return NextResponse.json({
        success: true,
        message: 'API connection test successful',
        query,
        details: testResult.details
      });
    } else {
      console.log('❌ [DuckDuckGo Instant Test] API connection failed');
      return NextResponse.json({
        success: false,
        message: 'API connection test failed',
        query,
        details: testResult.details
      }, { status: 500 });
    }
    
  } catch (error) {
    console.error('❌ [DuckDuckGo Instant Test] Test error:', error);
    
    return NextResponse.json({
      success: false,
      message: 'Test execution error',
      error: error instanceof Error ? error.message : 'Unknown error',
      query
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query = 'hello', test_type = 'connection' } = body;
    
    console.log(`🧪 [DuckDuckGo Instant Test] Starting ${test_type} test with query: "${query}"`);
    
    const instantApiService = DuckDuckGoInstantApiService.getInstance();
    
    let testResult;
    
    switch (test_type) {
      case 'connection':
        testResult = await instantApiService.testApiConnection(query);
        break;
        
      case 'web_results':
        testResult = await instantApiService.searchWebResults(query);
        break;
        
      case 'instant_answer':
        testResult = await instantApiService.searchInstantAnswer(query);
        break;
        
      default:
        return NextResponse.json({
          success: false,
          message: 'Invalid test type',
          valid_types: ['connection', 'web_results', 'instant_answer']
        }, { status: 400 });
    }
    
    return NextResponse.json({
      success: testResult.success,
      test_type,
      query,
      details: testResult.details || testResult,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ [DuckDuckGo Instant Test] POST test error:', error);
    
    return NextResponse.json({
      success: false,
      message: 'Test execution error',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
