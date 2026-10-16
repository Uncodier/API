import { EmailSendService } from '@/lib/services/email/EmailSendService';
import { EmailTrackingService } from '@/lib/services/tracking/EmailTrackingService';

/** Keep Zavu email formatting aligned with SMTP rather than sending HTML as text. */
export function exactEmailContent(message: string, siteName: string, signatureHtml: string, trackingId?: string) {
  const html = EmailSendService.buildHtmlContent(message, { name: siteName }, signatureHtml);
  const text = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  return { text, htmlBody: trackingId ? EmailTrackingService.injectTracking(html, trackingId) : html };
}