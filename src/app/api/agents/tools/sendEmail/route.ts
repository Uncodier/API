import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';

/**
 * Endpoint para enviar emails desde un agente
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      email, from, subject, message, agent_id, conversation_id, lead_id, site_id 
    } = body;
    
    if (!email || !subject || !message || !site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'email, subject, message, and site_id are required' } },
        { status: 400 }
      );
    }

    // Validate recipient email format before any API calls
    if (email !== 'no-email@example.com' && !EmailSendService.isValidEmail(email)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid recipient email format' } },
        { status: 400 }
      );
    }
    
    const { data: siteSettings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', site_id)
      .single();
    
    if (settingsError || !siteSettings) {
      return NextResponse.json(
        { success: false, error: { code: 'SITE_CONFIG_NOT_FOUND', message: 'Site configuration not found' } },
        { status: 404 }
      );
    }
    
    const agentEmailConfig = siteSettings.channels?.agent_email;
    const isAgentEmailActive = agentEmailConfig && agentEmailConfig.status === 'active';
    const configuredEmail = siteSettings.channels?.email?.email;

    // 0. Crear registro de mensaje para tracking (compartido entre AgentMail y SMTP)
    let trackingId: string | undefined;
    try {
      const { data: newMessage } = await supabaseAdmin
        .from('messages')
        .insert([{
          conversation_id, lead_id, agent_id, content: message, role: 'assistant',
          custom_data: { 
            subject, 
            recipient: email, 
            sender: configuredEmail || 'pending', 
            source: 'email_tool' 
          }
        }])
        .select('id')
        .single();
      if (newMessage) trackingId = newMessage.id;
    } catch (err) {
      console.warn(`[SEND_EMAIL] Tracking message error:`, err);
    }
    
    // 1. Integración AgentMail
    if (isAgentEmailActive && process.env.AGENTMAIL_API_KEY) {
      const username = agentEmailConfig.username || agentEmailConfig.data?.username;
      const domain = agentEmailConfig.domain || agentEmailConfig.data?.domain;
      
      if (username && domain) {
        try {
          const signature = await EmailSignatureService.generateAgentSignature(site_id, from).catch(() => ({ formatted: '' }));
          
          const result = await AgentMailSendService.sendViaAgentMail({
            email, subject, message, agent_id, conversation_id, lead_id, site_id,
            username, domain, senderEmail: `${username}@${domain}`,
            signatureHtml: signature.formatted,
            trackingId // Pasamos el trackingId para evitar duplicados
          });
          
          return NextResponse.json(result, { status: 201 });
        } catch (error: any) {
          console.error(`[SEND_EMAIL] AgentMail error:`, error);
          if (!configuredEmail) {
            return NextResponse.json({ success: false, error: { code: 'AGENTMAIL_FAILED', message: error.message } }, { status: 500 });
          }
        }
      }
    }
    
    // 2. Email nativo (SMTP)
    if (!configuredEmail || !EmailSendService.isValidEmail(configuredEmail)) {
      return NextResponse.json(
        { success: false, error: { code: 'EMAIL_NOT_CONFIGURED', message: 'Valid SMTP email not configured' } },
        { status: 400 }
      );
    }

    const signature = await EmailSignatureService.generateAgentSignature(site_id, from).catch(() => ({ formatted: '' }));
    
    // Actualizar registro de tracking para reflejar que se usa SMTP
    if (trackingId) {
      try {
        await supabaseAdmin
          .from('messages')
          .update({
            custom_data: { 
              subject, 
              recipient: email, 
              sender: configuredEmail, 
              source: 'smtp_tool' 
            }
          })
          .eq('id', trackingId);
      } catch (updateErr) {
        console.warn(`[SEND_EMAIL] Error updating tracking message for SMTP fallback:`, updateErr);
      }
    }

    const emailParams: any = {
      email, from: from || '', fromEmail: configuredEmail, subject, message,
      signatureHtml: signature.formatted, agent_id, conversation_id, lead_id, site_id,
      trackingId
    };

    const result = await EmailSendService.sendEmail(emailParams);
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 500 });

    const externalId = result.envelope_id || result.email_id;
    if (externalId && result.status === 'sent') {
      try {
        await SyncedObjectsService.createObject({
          external_id: externalId, site_id, object_type: 'sent_email', status: 'processed', provider: 'smtp_send_service',
          metadata: {
            recipient: result.recipient, sender: result.sender, subject: result.subject,
            message_preview: result.message_preview, sent_at: result.sent_at,
            agent_id, conversation_id, lead_id, smtp_message_id: result.email_id,
            envelope_id: result.envelope_id, source: 'api_send', processed_at: new Date().toISOString()
          }
        });
      } catch (syncError) {
        console.warn(`[SEND_EMAIL] SyncedObject error:`, syncError);
      }
    }

    return NextResponse.json({ ...result, external_message_id: externalId }, { status: result.status === 'skipped' ? 200 : 201 });
  } catch (error: any) {
    console.error(`[SEND_EMAIL] Critical error:`, error);
    return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } }, { status: 500 });
  }
}
