import { authorizeChatTurn } from '@/app/api/agents/chat/message/authorize-turn';
import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { WorkflowService } from '@/lib/services/workflow-service';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const reply = z.object({ success:z.literal(true), data:z.object({conversation_id:z.string().uuid(), messages:z.object({
  assistant:z.object({message_id:z.string().uuid(),content:z.string().min(1).max(100000)})
})}) });

export function POST(request: Request) {
  return withAuthorizedCommandRequest(request, async () => {
    const turn = await authorizeChatTurn(request, await request.json());
    if (turn instanceof Response) return turn;
    const result = await WorkflowService.getInstance().agentMessage({ ...turn, userId: turn.team_member_id, origin: 'chat' }, {
      priority: 'high', async: false, retryAttempts: 3, taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
      workflowId: `agent-message-${turn.site_id}-${randomUUID()}`,
    });
    const parsed = result.success && reply.safeParse(result.data);
    if (parsed && parsed.success && parsed.data.data.conversation_id === turn.conversationId) {
      const current = await authorizeChatTurn(request, turn);
      if (current instanceof Response) return current;
      if (current.lead_id === turn.lead_id && current.visitor_id === turn.visitor_id) return Response.json(parsed.data);
    }
    return Response.json({ success: false, error: {
      code: 'WORKFLOW_EXECUTION_ERROR', message: 'Agent chat workflow failed.',
    } }, {status: 500});
  });
}

export function GET() {
  return Response.json({ name: 'agentMessageWorkflow API', methods: ['POST'],
    requiredParams: { message: 'Message text', site_id: 'Workspace UUID', conversationId: 'Existing internal conversation UUID' } });
}
