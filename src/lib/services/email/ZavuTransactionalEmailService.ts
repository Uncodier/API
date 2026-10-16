import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendChannelMessage, zavuFetch, type ZavuEmailAttachment } from '@/lib/services/zavu/client';
import type { SendEmailParams, SendEmailResult } from '@/lib/services/sendgrid-service';
import { getTransactionalEmailFrom, getTransactionalEmailConfigurationDiagnostic, getTransactionalEmailFailureDiagnostic,
  type TransactionalEmailDiagnostic } from './transactional-email-config';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const acceptedStates = new Set(['queued', 'sending', 'sent', 'delivered', 'read']);
class TransactionalEmailConfigurationError extends Error {}
class TransactionalEmailSenderError extends Error {
  constructor(readonly diagnostic: TransactionalEmailDiagnostic) { super('Transactional email sender is unavailable'); }
}

function plainText(html: string): string {
  const $ = load(html);
  $('head, script, style').remove();
  $('a[href]').each((_, element) => {
    const link = $(element);
    link.append(` (${link.attr('href')})`);
  });
  $('br').replaceWith('\n');
  $('p, div, tr, li, h1, h2, h3').append('\n');
  return $.root().text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
}

function attachmentsForZavu(params: SendEmailParams): ZavuEmailAttachment[] | undefined {
  if (!params.attachments) return undefined;
  if (params.attachments.length > 50) throw new TransactionalEmailConfigurationError('Zavu supports at most 50 attachments');
  let bytes = 0;
  return params.attachments.map(attachment => {
    if (!attachment.filename || attachment.filename.length > 255
      || !attachment.content || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)
      || attachment.content.length % 4 !== 0) {
      throw new TransactionalEmailConfigurationError('Invalid email attachment');
    }
    if ((attachment.disposition === 'inline' && !attachment.contentId)
      || (attachment.contentId && attachment.contentId.length > 100)) {
      throw new TransactionalEmailConfigurationError('Inline attachments require contentId for Zavu');
    }
    bytes += Buffer.byteLength(attachment.content, 'base64');
    if (bytes > 40 * 1024 * 1024) throw new TransactionalEmailConfigurationError('Zavu attachments exceed 40MB');
    return {
      filename: attachment.filename,
      content: attachment.content,
      ...(attachment.type ? { content_type: attachment.type } : {}),
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
    };
  });
}

/** Resolve only the operator-pinned site connection, never caller metadata or a default sender. */
export async function resolveZavuTransactionalSender(signal: AbortSignal): Promise<string> {
  const from = getTransactionalEmailFrom()?.toLowerCase();
  const siteId = process.env.TRANSACTIONAL_EMAIL_ZAVU_SITE_ID?.trim();
  const connectionId = process.env.TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID?.trim();
  const pinnedSenderId = process.env.TRANSACTIONAL_EMAIL_ZAVU_SENDER_ID?.trim();
  if (!from || !emailPattern.test(from) || !siteId || !connectionId) {
    throw new TransactionalEmailConfigurationError('Configure TRANSACTIONAL_EMAIL_FROM_EMAIL, TRANSACTIONAL_EMAIL_ZAVU_SITE_ID and TRANSACTIONAL_EMAIL_ZAVU_CONNECTION_ID');
  }
  if (!process.env.ZAVUDEV_API_KEY?.trim()) throw new TransactionalEmailConfigurationError('Missing ZAVUDEV_API_KEY');
  signal.throwIfAborted();
  const { data, error } = await supabaseAdmin.from('settings').select('channels')
    .eq('site_id', siteId).abortSignal(signal).maybeSingle();
  if (error) throw new TransactionalEmailSenderError({ stage: 'sender_resolution', code: 'connection_lookup_failed' });
  const connections = Array.isArray(data?.channels?.connections) ? data.channels.connections : [];
  const matches = connections.filter((connection: any) => connection.id === connectionId);
  const connection = matches[0];
  if (matches.length !== 1 || connection.type !== 'email' || connection.status !== 'connected'
    || connection.metadata?.from_address?.trim().toLowerCase() !== from
    || !connection.zavu_sender_id || !connection.metadata?.email_domain_id
    || (pinnedSenderId && connection.zavu_sender_id !== pinnedSenderId)) {
    throw new TransactionalEmailSenderError({ stage: 'sender_resolution', code: 'connection_mismatch' });
  }
  let senderResponse: any, domainResponse: any;
  try {
    [senderResponse, domainResponse] = await Promise.all([
      zavuFetch<any>(`/senders/${encodeURIComponent(connection.zavu_sender_id)}`, { signal }),
      zavuFetch<any>(`/email-domains/${encodeURIComponent(connection.metadata.email_domain_id)}`, { signal }),
    ]);
  } catch (error) {
    throw new TransactionalEmailSenderError(getTransactionalEmailFailureDiagnostic(error, 'sender_verification'));
  }
  const sender = senderResponse.sender || senderResponse;
  const domain = domainResponse.domain || domainResponse;
  if (sender.id !== connection.zavu_sender_id || sender.emailAddress?.trim().toLowerCase() !== from
    || !Array.isArray(sender.channels) || !sender.channels.includes('email')
    || domain.id !== connection.metadata.email_domain_id || domain.status !== 'verified') {
    throw new TransactionalEmailSenderError({ stage: 'sender_verification', code: 'sender_not_verified' });
  }
  return sender.id;
}

export async function sendZavuTransactionalEmail(params: SendEmailParams): Promise<SendEmailResult> {
  let stage: TransactionalEmailDiagnostic['stage'] = 'validation';
  try {
    const configurationDiagnostic = getTransactionalEmailConfigurationDiagnostic();
    if (configurationDiagnostic) return { success: false, provider: 'zavu', statusCode: 502,
      diagnostic: configurationDiagnostic, error: 'Transactional email configuration is incomplete or invalid' };
    // Fail before any sends instead of dropping SendGrid-only features.
    if (params.cc || params.bcc || params.templateId || params.dynamicTemplateData || params.sendAt !== undefined) {
      throw new TransactionalEmailConfigurationError('CC, BCC, dynamic templates and scheduled sends require TRANSACTIONAL_EMAIL_PROVIDER=sendgrid');
    }
    const recipients = [...new Set((Array.isArray(params.to) ? params.to : [params.to]).map(to => to.trim().toLowerCase()))];
    const text = params.text || (params.html ? plainText(params.html) : '');
    if (!recipients.length || recipients.some(to => !emailPattern.test(to))
      || !params.subject?.trim() || params.subject.length > 998 || !text.trim()
      || (params.replyTo && !emailPattern.test(params.replyTo))) {
      throw new TransactionalEmailConfigurationError('Valid recipients, subject and email content are required');
    }
    const attachments = attachmentsForZavu(params);
    const signal = params.signal || AbortSignal.timeout(10_000);
    stage = 'sender_resolution';
    const senderId = await resolveZavuTransactionalSender(signal);
    const operationKey = params.idempotencyKey || randomUUID();
    const recipientResults: NonNullable<SendEmailResult['recipientResults']> = [];
    for (const to of recipients) {
      try {
        signal.throwIfAborted();
        // Bind the operation to the exact sender, recipient and payload. Hashes
        // keep auth tokens and message bodies out of keys and logs.
        const idempotencyKey = `transactional-${createHash('sha256').update(JSON.stringify({
          operationKey, senderId, to, subject: params.subject, text, html: params.html,
          replyTo: params.replyTo, attachments,
        })).digest('hex')}`;
        const response = await sendChannelMessage({
          to, channel: 'email', senderId, subject: params.subject, text,
          htmlBody: params.html, replyTo: params.replyTo, attachments, signal, idempotencyKey,
          metadata: { ...params.customArgs, categories: JSON.stringify(params.categories || []), purpose: 'transactional' },
        });
        const message = response?.message;
        const success = typeof message?.id === 'string' && message.id.length > 0 && acceptedStates.has(message.status);
        recipientResults.push({
          to, success, messageId: message?.id, status: message?.status,
          ...(!success ? { error: 'Zavu did not confirm message acceptance',
            diagnostic: { stage: 'acceptance' as const, code: 'message_not_accepted' as const } } : {}),
        });
      } catch (error) {
        // Delivery may be uncertain. Never retry or switch providers implicitly.
        recipientResults.push({ to, success: false, status: 'unconfirmed', error: 'Zavu email send failed or is unconfirmed',
          diagnostic: getTransactionalEmailFailureDiagnostic(error, 'dispatch') });
      }
    }
    const success = recipientResults.every(result => result.success);
    return {
      success, provider: 'zavu', statusCode: success ? 202 : 502,
      messageId: recipients.length === 1 ? recipientResults[0].messageId : undefined,
      status: success ? (recipients.length === 1 ? recipientResults[0].status : 'accepted') : 'unconfirmed',
      recipientResults,
      ...(!success ? { diagnostic: recipientResults.find(result => !result.success)?.diagnostic } : {}),
      ...(!success ? { error: 'One or more Zavu emails failed or are unconfirmed; inspect recipientResults before retrying' } : {}),
    };
  } catch (error) {
    // Configuration/validation errors are local; never log provider responses,
    // credentials, bodies, OTPs or confirmation links.
    return { success: false, provider: 'zavu', statusCode: 502,
      diagnostic: error instanceof TransactionalEmailSenderError ? error.diagnostic
        : error instanceof TransactionalEmailConfigurationError ? { stage: 'validation',
          code: params.cc || params.bcc || params.templateId || params.dynamicTemplateData || params.sendAt !== undefined ? 'unsupported_feature' : 'invalid_request' }
        : getTransactionalEmailFailureDiagnostic(error, stage),
      error: error instanceof TransactionalEmailConfigurationError ? error.message : 'Zavu transactional email is unavailable' };
  }
}
