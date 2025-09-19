import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createTask } from '@/lib/database/task-db';
import { WorkflowService } from '@/lib/services/workflow-service';

const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const BUCKET = 'assets';
const CONVERSATION_REUSE_WINDOW_MIN = 30;

function isValidUUID(v?: string | null) {
  if (!v) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeExtFromMime(mime: string | undefined, fallback: string = 'bin') {
  if (!mime) return fallback;
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'text/plain': 'txt'
  };
  const ext = map[mime.toLowerCase()] || fallback;
  return ext.replace(/[^a-zA-Z0-9]/g, '') || fallback;
}

export type TwilioMediaDownload = {
  url: string;
  contentType?: string;
};

async function downloadTwilioMedia(url: string, accountSid: string, authToken: string): Promise<{ buffer: ArrayBuffer; contentType?: string } | null> {
  const headers = new Headers();
  headers.set('Authorization', `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`);
  const resp = await fetch(url, { headers });
  if (!resp.ok) return null;
  const buffer = await resp.arrayBuffer();
  const contentType = resp.headers.get('content-type') || undefined;
  return { buffer, contentType };
}

export async function handleTwilioMediaAndCreateTask(params: {
  siteId: string;
  userId: string;
  agentId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  messageText?: string;
  workflowOrigin?: 'whatsapp' | 'website_chat';
  media: Array<TwilioMediaDownload>;
  twilioAuth: { accountSid: string; authToken: string };
  logPrefix?: string;
}) {
  const traceId = crypto.randomUUID();
  const log = (msg: string, extra?: any) => console.log(`[TwilioMediaTask:${traceId}] ${msg}`, extra ?? '');
  const warn = (msg: string, extra?: any) => console.warn(`[TwilioMediaTask:${traceId}] ${msg}`, extra ?? '');

  const {
    siteId,
    userId,
    agentId,
    leadId: initialLeadId,
    conversationId: initialConversationId,
    messageText,
    workflowOrigin = 'whatsapp',
    media,
    twilioAuth: { accountSid, authToken },
  } = params;

  if (!media.length) return { success: false, error: 'No media to process' } as const;

  // 1) Resolve conversation
  let conversationId = initialConversationId || null;
  let leadId = initialLeadId || null;

  if (!isValidUUID(conversationId)) {
    const sinceIso = new Date(Date.now() - CONVERSATION_REUSE_WINDOW_MIN * 60 * 1000).toISOString();
    let existing: { id: string; user_id: string | null } | null = null;

    if (leadId) {
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
    } else {
      const insertConv: any = {
        site_id: siteId,
        status: 'active',
        title: (messageText || 'WhatsApp media message').substring(0, 100),
        custom_data: { source: 'whatsapp', channel: 'whatsapp' },
      };
      if (leadId) insertConv.lead_id = leadId;
      if (agentId && isValidUUID(agentId)) insertConv.agent_id = agentId;

      const { data: newConv, error: convErr } = await supabaseAdmin
        .from('conversations')
        .insert([insertConv])
        .select('id, user_id')
        .single();
      if (convErr) {
        return { success: false, error: `Failed to create conversation: ${convErr.message}` } as const;
      }
      conversationId = newConv.id;
    }
  }

  if (!isValidUUID(conversationId)) {
    return { success: false, error: 'conversation_id could not be resolved or created' } as const;
  }

  // 2) Upload media to storage
  const uploadedFiles: Array<{
    name: string;
    size: number;
    type: string;
    bucket: string;
    path: string;
    url: string;
  }> = [];

  for (let idx = 0; idx < media.length; idx++) {
    const item = media[idx];
    const dl = await downloadTwilioMedia(item.url, accountSid, authToken);
    if (!dl) {
      warn('Failed to download media', { url: item.url });
      continue;
    }
    if (dl.buffer.byteLength > MAX_FILE_SIZE) {
      warn(`Media exceeds ${MAX_FILE_SIZE_MB}MB, skipping`, { url: item.url });
      continue;
    }
    const ext = safeExtFromMime(item.contentType || dl.contentType);
    const objPath = `sites/${siteId}/conversations/${conversationId}/${Date.now()}_${crypto.randomUUID()}.${ext}`;

    const { data: up, error: upErr } = await supabaseAdmin
      .storage
      .from(BUCKET)
      .upload(objPath, Buffer.from(dl.buffer), {
        contentType: dl.contentType || 'application/octet-stream',
        upsert: false,
      });
    if (upErr) {
      warn('Upload failed', upErr.message);
      continue;
    }
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(objPath);
    let url = pub?.publicUrl || '';
    if (!url) {
      const { data: signed } = await supabaseAdmin
        .storage
        .from(BUCKET)
        .createSignedUrl(objPath, 60 * 60 * 24 * 7);
      url = signed?.signedUrl || '';
    }
    uploadedFiles.push({
      name: `media_${idx + 1}.${ext}`,
      size: dl.buffer.byteLength,
      type: dl.contentType || 'application/octet-stream',
      bucket: BUCKET,
      path: up!.path,
      url,
    });
  }

  if (!uploadedFiles.length) {
    return { success: false, error: 'No media could be uploaded' } as const;
  }

  // 3) Find existing task or create new
  const userMessage = (messageText || `WhatsApp uploaded ${uploadedFiles.length} file(s)`).toString();
  let taskIdToUse: string | null = null;
  let createdNewTask = false;
  let workflowTitle: string | null = null;
  let workflowId: string | null = null;

  const { data: existingTask } = await supabaseAdmin
    .from('tasks')
    .select('id, status, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const isReplyOnly = !!existingTask?.id;
  if (isReplyOnly) {
    taskIdToUse = existingTask!.id;
  }

  // Start customerSupport workflow for parity with upload
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
        origin: workflowOrigin,
      },
      {
        priority: 'high',
        async: false,
        retryAttempts: 3,
        taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
        workflowId: directWorkflowId,
      }
    );
    const data = (wfResult as any)?.data || {};
    workflowTitle = data?.title || data?.ticket_title || data?.subject || null;
    workflowId = (wfResult as any)?.workflowId || data?.workflowId || data?.workflow_id || directWorkflowId;
  } catch {}

  if (!isReplyOnly) {
    const newTask = await createTask({
      title: workflowTitle || 'Customer support ticket',
      description: messageText || '',
      type: 'ticket',
      status: 'pending',
      stage: 'consideration',
      priority: 1,
      user_id: userId,
      site_id: siteId,
      lead_id: leadId || undefined,
      conversation_id: conversationId || undefined,
      scheduled_date: new Date().toISOString(),
      notes: 'Task created from WhatsApp media upload',
    });
    taskIdToUse = newTask.id;
    createdNewTask = true;
  }

  const { data: comment, error: commentErr } = await supabaseAdmin
    .from('task_comments')
    .insert([
      {
        task_id: taskIdToUse,
        user_id: userId,
        content: userMessage || 'File(s) uploaded via WhatsApp.',
        files: uploadedFiles,
        attachments: uploadedFiles,
        is_private: false,
      },
    ])
    .select('id')
    .single();

  return {
    success: true,
    conversationId: conversationId!,
    taskId: taskIdToUse!,
    createdNewTask,
    commentId: comment?.id,
    files: uploadedFiles,
    workflowId,
    workflowTitle,
  } as const;
}


