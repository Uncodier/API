import { NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';
import { visitorSessionAuthorizationService, visitorAuthorizationErrorResponse } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { readSupportRequest, supportMessageId, supportRequestError } from '../request-contract';

export const dynamic = 'force-dynamic';

/** Poll a single server-derived workflow ID using the same visitor authorization as the send. */
export async function POST(request: Request) {
  try {
    const body = await readSupportRequest(request);
    if (!body || supportRequestError(body, true) || typeof body.session_id !== 'string' || !body.session_id.trim()) {
      return NextResponse.json({ error: 'Invalid status request' }, { status: 400 });
    }
    const identity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request, siteId: body.site_id as string, sessionId: body.session_id,
    });
    if (!identity) return NextResponse.json({ error: 'Visitor session is required' }, { status: 403 });
    const id = supportMessageId(identity.siteId, identity.sessionId, body.client_message_id as string, body.message as string);
    const workflowId = `customer-support-message-${identity.siteId}-${id}`;
    const result = await WorkflowService.getInstance().getFinishedWorkflowResult(workflowId);
    if (!result.success) {
      const terminal = result.error?.code === 'WORKFLOW_FAILED';
      return NextResponse.json({ success: false, status: terminal ? 'failed' : 'unavailable', error: result.error }, { status: terminal ? 422 : 503 });
    }
    return NextResponse.json({ success: true, data: result.status === 'completed' ? result.data : { status: 'running' } });
  } catch (error) {
    const authorizationResponse = visitorAuthorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    console.error('Failed to read Customer Support status:', error);
    return NextResponse.json({ success: false, error: 'Status unavailable' }, { status: 503 });
  }
}