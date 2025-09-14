import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isOriginAllowedInDb } from '@/lib/cors/cors-db';
import { createTask } from '@/lib/database/task-db';
import { TeamNotificationService } from '@/lib/services/team-notification-service';
import { NotificationType } from '@/lib/services/notification-service';
import { WorkflowService } from '@/lib/services/workflow-service';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  } as Record<string, string>;
}

function json(res: any, status: number, request: NextRequest) {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

function jsonT(res: any, status: number, request: NextRequest, traceId: string) {
  const payload = typeof res === 'object' && res !== null ? { ...res, trace_id: traceId } : res;
  return json(payload, status, request);
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const BUCKET = 'assets';
const CONVERSATION_REUSE_WINDOW_MIN = 30;

function isValidUUID(v?: string | null) {
  if (!v) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(request: NextRequest) {
  try {
    const traceId = crypto.randomUUID();
    const origin = request.headers.get('origin') || '';
    const contentType = request.headers.get('content-type') || '';

    console.log(`[VisitorsUpload:${traceId}] ▶️ Incoming request`);
    console.log(`[VisitorsUpload:${traceId}] CP0 headers:`, {
      origin,
      contentType,
      method: request.method
    });

    const allowed = await isOriginAllowedInDb(origin);
    console.log(`[VisitorsUpload:${traceId}] CP1 origin allowed:`, allowed);
    if (!allowed) return jsonT({ success: false, error: 'Origin not allowed' }, 403, request, traceId);

    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return jsonT({ success: false, error: 'Unsupported content type. Use multipart/form-data' }, 415, request, traceId);
    }

    // 5d) If workflow didn't return a title, we'll try to read the conversation title later once conversationId is confirmed

    let form: FormData;
    try {
      form = await request.formData();
    } catch (e: any) {
      console.error(`[VisitorsUpload:${traceId}] ❌ Failed parsing formData:`, e?.message || e);
      return jsonT({ success: false, error: 'Failed to parse multipart/form-data', details: e?.message }, 400, request, traceId);
    }

    const siteId = (form.get('site_id') || '').toString();
    let conversationId = form.get('conversation_id')?.toString() || null;
    const visitorId = form.get('visitor_id')?.toString() || null;
    let leadId = form.get('lead_id')?.toString() || null;
    let userId = form.get('user_id')?.toString() || null;
    const agentId = form.get('agent_id')?.toString() || null;

    const title = form.get('title')?.toString() || 'User uploaded file';
    const description = form.get('description')?.toString() || '';
    const textMessage = form.get('message')?.toString() || '';
    const taskType = form.get('type')?.toString() || 'user_upload';

    const rawFiles = form.getAll('file');
    const files = rawFiles.filter((f: any) => f && typeof (f as any).arrayBuffer === 'function') as any[];
    console.log(`[VisitorsUpload:${traceId}] CP2a file detection:`, {
      rawCount: rawFiles.length,
      detectedFileCount: files.length
    });

    console.log(`[VisitorsUpload:${traceId}] CP2 parsed fields:`, {
      siteId,
      conversationId,
      visitorId,
      leadId,
      userId,
      agentId,
      title,
      hasMessage: !!textMessage,
      filesCount: files.length
    });

    if (!siteId) return jsonT({ success: false, error: 'site_id is required' }, 400, request, traceId);
    if (!files.length) return jsonT({ success: false, error: 'At least one file is required under key "file"' }, 400, request, traceId);

    // Resolve lead_id from visitor if missing
    if (!leadId && visitorId) {
      console.log(`[VisitorsUpload:${traceId}] CP3 resolving lead from visitor:`, visitorId);
      const { data: vrow, error: vErr } = await supabaseAdmin
        .from('visitors')
        .select('lead_id')
        .eq('id', visitorId)
        .maybeSingle();
      if (vErr) {
        console.warn(`[VisitorsUpload:${traceId}] ⚠️ resolve lead by visitor error:`, vErr.message);
      }
      leadId = vrow?.lead_id || null;
    }

    // Validate sizes
    for (const f of files) {
      if (f.size > MAX_FILE_SIZE) {
        return json({ success: false, error: `File ${f.name} exceeds ${MAX_FILE_SIZE_MB}MB` }, 413, request);
      }
    }

    // 1) Find or create conversation if missing
    if (!isValidUUID(conversationId)) {
      const sinceIso = new Date(Date.now() - CONVERSATION_REUSE_WINDOW_MIN * 60 * 1000).toISOString();

      let existing: { id: string; user_id: string | null } | null = null;

      if (visitorId) {
        const { data } = await supabaseAdmin
          .from('conversations')
          .select('id, user_id, last_message_at, status')
          .eq('site_id', siteId)
          .eq('visitor_id', visitorId)
          .eq('status', 'active')
          .order('last_message_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data && (data.last_message_at ? data.last_message_at >= sinceIso : true)) {
          existing = { id: data.id, user_id: data.user_id };
        }
      }

      if (!existing && leadId) {
        const { data } = await supabaseAdmin
          .from('conversations')
          .select('id, user_id, last_message_at, status')
          .eq('site_id', siteId)
          .eq('lead_id', leadId)
          .eq('status', 'active')
          .order('last_message_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data && (data.last_message_at ? data.last_message_at >= sinceIso : true)) {
          existing = { id: data.id, user_id: data.user_id };
        }
      }

      if (existing) {
        conversationId = existing.id;
        if (!userId) userId = existing.user_id || null;
      } else {
        const insertConv: any = {
          site_id: siteId,
          status: 'active',
          title: (textMessage || description)
            ? (textMessage || description).substring(0, 100)
            : 'Conversation (upload)',
          custom_data: { source: 'tracking_upload' },
        };
        if (visitorId) insertConv.visitor_id = visitorId;
        if (leadId) insertConv.lead_id = leadId;
        if (agentId && isValidUUID(agentId)) insertConv.agent_id = agentId;

        const { data: newConv, error: convErr } = await supabaseAdmin
          .from('conversations')
          .insert([insertConv])
          .select('id, user_id')
          .single();

        if (convErr) {
          return json({ success: false, error: 'Failed to create conversation', details: convErr.message }, 500, request);
        }
        conversationId = newConv.id;
        if (!userId) userId = newConv.user_id || null;
      }
    }

    if (!isValidUUID(conversationId)) {
      return json({ success: false, error: 'conversation_id could not be resolved or created' }, 400, request);
    }

    // 2) Ensure user_id fallback from site owner if still missing
    if (!userId) {
      const { data: siteRow } = await supabaseAdmin
        .from('sites')
        .select('user_id')
        .eq('id', siteId)
        .maybeSingle();
      userId = siteRow?.user_id || null;
    }
    if (!userId) {
      return json({ success: false, error: 'user_id could not be resolved' }, 400, request);
    }

    // 3) Upload files to storage
    const uploadedFiles: Array<{
      name: string;
      size: number;
      type: string;
      bucket: string;
      path: string;
      url: string;
    }> = [];

    console.log(`[VisitorsUpload:${traceId}] CP4 uploading ${files.length} file(s)`);
    for (const f of files) {
      const origName = f.name || 'upload.bin';
      const ext = origName.includes('.') ? (origName.split('.').pop() as string) : 'bin';
      const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
      const objPath = `sites/${siteId}/conversations/${conversationId}/${Date.now()}_${crypto.randomUUID()}.${safeExt}`;

      console.log(`[VisitorsUpload:${traceId}] CP4a file:`, { name: origName, size: f.size, type: f.type, objPath });
      const buffer = await f.arrayBuffer();
      const { data: up, error: upErr } = await supabaseAdmin
        .storage
        .from(BUCKET)
        .upload(objPath, buffer, {
          contentType: f.type || 'application/octet-stream',
          upsert: false,
        });

      if (upErr) {
        console.error(`[VisitorsUpload:${traceId}] ❌ Upload failed:`, upErr.message);
        return jsonT({ success: false, error: 'Upload failed', details: upErr.message }, 500, request, traceId);
      }

      const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(objPath);
      let url = pub?.publicUrl || '';

      if (!url) {
        const { data: signed, error: signErr } = await supabaseAdmin
          .storage
          .from(BUCKET)
          .createSignedUrl(objPath, 60 * 60 * 24 * 7);
        if (signErr || !signed?.signedUrl) {
          console.error(`[VisitorsUpload:${traceId}] ❌ Failed to generate file URL:`, signErr?.message);
          return jsonT({ success: false, error: 'Failed to generate file URL', details: signErr?.message }, 500, request, traceId);
        }
        url = signed.signedUrl;
      }

      uploadedFiles.push({
        name: origName,
        size: f.size,
        type: f.type || 'application/octet-stream',
        bucket: BUCKET,
        path: up.path,
        url,
      });
    }

    // 4) Decide whether there is an existing task for this conversation
    const userMessage = (textMessage || description || `User uploaded ${uploadedFiles.length} file(s)`).toString();
    console.log(`[VisitorsUpload:${traceId}] CP5 finding existing task for conversation`);
    let taskIdToUse: string | null = null;
    let createdNewTask = false;
    let workflowTitle: string | null = null;
    let workflowId: string | null = null;

    const { data: existingTask, error: findTaskErr } = await supabaseAdmin
      .from('tasks')
      .select('id, status, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findTaskErr) {
      console.warn(`[VisitorsUpload:${traceId}] ⚠️ find existing task error:`, findTaskErr.message);
    }

    const isReplyOnly = !!existingTask?.id;
    if (isReplyOnly) {
      taskIdToUse = existingTask!.id;
      console.log(`[VisitorsUpload:${traceId}] CP5a reusing existing task ${taskIdToUse}`);
    } else {
      console.log(`[VisitorsUpload:${traceId}] CP5b no existing task, will create new after workflow`);
    }

    // 5) Start Temporal customer support workflow with the user's message (direct call)
    console.log(`[VisitorsUpload:${traceId}] CP5c starting customerSupport workflow (mode=${isReplyOnly ? 'reply_only' : 'create'})`);
    try {
      const workflowService = WorkflowService.getInstance();
      const directWorkflowId = `customer-support-message-${siteId || 'nosid'}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const wfResult = await workflowService.customerSupportMessage(
        {
          conversationId: conversationId || undefined,
          userId: userId || undefined,
          message: userMessage,
          agentId: agentId || undefined,
          site_id: siteId || undefined,
          lead_id: leadId || undefined,
          visitor_id: visitorId || undefined,
          origin: 'website_chat',
          website_chat_origin: true,
          lead_notification: isReplyOnly ? 'reply_only' : 'create_ticket'
        },
        {
          priority: 'high',
          async: false,
          retryAttempts: 3,
          taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
          workflowId: directWorkflowId
        }
      );
      if (!wfResult?.success) {
        console.warn(`[VisitorsUpload:${traceId}] ⚠️ customerSupport workflow reported failure:`, wfResult?.error);
      }
      const data = wfResult?.data || {};
      workflowTitle = data?.title || data?.ticket_title || data?.subject || null;
      workflowId = wfResult?.workflowId || data?.workflowId || data?.workflow_id || directWorkflowId;
    } catch (e: any) {
      console.warn(`[VisitorsUpload:${traceId}] ⚠️ customerSupport workflow start failed:`, e?.message || e);
    }

    // 5e) Fallback: if workflow didn't return a title, try to fetch conversation title now
    if (!workflowTitle && isValidUUID(conversationId)) {
      try {
        const { data: conv } = await supabaseAdmin
          .from('conversations')
          .select('title')
          .eq('id', conversationId as string)
          .maybeSingle();
        workflowTitle = conv?.title || null;
      } catch {}
    }

    // 6) Create task if needed, else reuse existing
    if (!isReplyOnly) {
      console.log(`[VisitorsUpload:${traceId}] CP6 creating new task`);
      const newTask = await createTask({
        title: workflowTitle || 'Customer support ticket',
        description: textMessage || '',
        type: 'ticket',
        status: 'pending',
        stage: 'consideration',
        priority: 1,
        user_id: userId,
        site_id: siteId,
        lead_id: leadId || undefined,
        conversation_id: conversationId || undefined,
        scheduled_date: new Date().toISOString(),
        notes: 'Task created from tracking upload',
      });
      taskIdToUse = newTask.id;
      createdNewTask = true;
      console.log(`[VisitorsUpload:${traceId}] CP6a created task ${taskIdToUse}`);
    }

    const { data: comment, error: commentErr } = await supabaseAdmin
      .from('task_comments')
      .insert([
        {
          task_id: taskIdToUse,
          user_id: userId,
          content: userMessage || 'File(s) uploaded via tracking script.',
          files: uploadedFiles,
          attachments: uploadedFiles,
          is_private: false,
        },
      ])
      .select('id')
      .single();

    if (commentErr) {
      console.warn(`[VisitorsUpload:${traceId}] ⚠️ Task step completed but failed to add files comment:`, commentErr.message);
      return jsonT(
        {
          success: true,
          warning: 'Task created but failed to add files comment',
          details: commentErr.message,
          task_id: taskIdToUse,
          conversation_id: conversationId,
          files: uploadedFiles,
          used_existing_task: !createdNewTask
        },
        200,
        request,
        traceId
      );
    }

    // 6) Notify team only if a new task was created (reuse Task tool notifier style)
    let teamNotificationSummary: any = null;
    if (createdNewTask && taskIdToUse) {
      try {
        const notifyResult = await (await import('@/lib/services/TaskNotifier')).TaskNotifier.notifyTaskCreated({
          task: {
            id: taskIdToUse as string,
            title: workflowTitle || 'Customer support ticket',
            description: textMessage || '',
            type: 'ticket',
            priority: 1,
            site_id: siteId,
            lead_id: leadId || null,
            assignee: null,
            scheduled_date: new Date().toISOString()
          }
        });
        teamNotificationSummary = {
          success: notifyResult.success,
          notifications_sent: notifyResult.notificationsSent,
          emails_sent: notifyResult.emailsSent,
          total_members: notifyResult.totalMembers
        };
        console.log(`[VisitorsUpload:${traceId}] 📢 Team notified about new ticket (TaskNotifier)`, teamNotificationSummary);
      } catch (e: any) {
        console.warn(`[VisitorsUpload:${traceId}] ⚠️ Failed to notify team about new ticket:`, e?.message || e);
        teamNotificationSummary = { success: false, error: e?.message || 'notification_failed' };
      }
    }

    console.log(`[VisitorsUpload:${traceId}] ✅ Completed successfully`, {
      task_id: taskIdToUse,
      comment_id: comment.id,
      conversation_id: conversationId,
      lead_id: leadId,
      files: uploadedFiles.length,
      used_existing_task: !createdNewTask,
      workflow_id: workflowId,
      workflow_title: workflowTitle,
      team_notification: teamNotificationSummary
    });
    return jsonT(
      {
        success: true,
        task_id: taskIdToUse,
        comment_id: comment.id,
        conversation_id: conversationId,
        lead_id: leadId,
        files: uploadedFiles,
        used_existing_task: !createdNewTask,
        workflow_id: workflowId,
        workflow_title: workflowTitle,
        team_notification: teamNotificationSummary
      },
      200,
      request,
      traceId
    );
  } catch (err: any) {
    const traceId = crypto.randomUUID();
    console.error(`[VisitorsUpload:${traceId}] ❌ Uncaught error:`, err?.stack || err);
    return jsonT({ success: false, error: 'Internal server error', message: err?.message || String(err) }, 500, request, traceId);
  }
}


