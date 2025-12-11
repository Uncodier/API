import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { leadFollowUpService } from '@/lib/services/lead-followup/LeadFollowUpService';

export async function POST(request: Request) {
  const requestId = uuidv4();
  
  try {
    const result = await leadFollowUpService.processRequest(request, requestId);
    
    return NextResponse.json({
      success: true,
      data: result
    });
    
  } catch (error: any) {
    // Handle known errors (thrown as objects with code, message, status)
    if (error.code && error.status) {
        return NextResponse.json(
            {
                success: false,
                error: {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    trace_id: requestId,
                    action_taken: error.action_taken,
                    tool_execution_error: error.tool_execution_error
                }
            },
            { status: error.status }
        );
    }

    console.error(`❌ [LeadFollowUp:${requestId}] UNHANDLED ERROR:`, error);
    console.error(`❌ [LeadFollowUp:${requestId}] Error message:`, error.message);
    console.error(`❌ [LeadFollowUp:${requestId}] Stack trace:`, error.stack);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'UNHANDLED_ERROR', 
          message: error.message || 'An internal system error occurred',
          trace_id: requestId
        } 
      },
      { status: 500 }
    );
  }
}
