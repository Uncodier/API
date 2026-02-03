import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createTask } from '@/lib/database/task-db';
import { isValidUUID } from '@/lib/helpers/command-utils';
import { EmailSendService } from '../email/EmailSendService';

export interface TrackingEvent {
  at: string;
  ip?: string;
  ua?: string;
  url?: string;
}

export interface MessageInteraction {
  open_count: number;
  click_count: number;
  opens: TrackingEvent[];
  clicks: TrackingEvent[];
}

export class EmailTrackingService {
  private static getBaseUrl(): string {
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  }

  /**
   * Inyecta rastreo de apertura y clics en el HTML de un correo.
   */
  static injectTracking(html: string, messageId: string): string {
    if (!messageId || !isValidUUID(messageId)) {
      console.warn('[EmailTrackingService] Invalid messageId for tracking injection');
      return html;
    }

    const baseUrl = this.getBaseUrl();
    
    // 1. Envolver todos los links <a>
    // Regex para encontrar href="..." y evitar los que ya están trackeados o son anclas internas
    const linkRegex = /href="((?!#|mailto:|tel:|javascript:)[^"]+)"/gi;
    let modifiedHtml = html.replace(linkRegex, (match, url) => {
      const encodedUrl = encodeURIComponent(url);
      const trackingUrl = `${baseUrl}/api/tracking/email?m=${messageId}&a=click&url=${encodedUrl}`;
      return `href="${EmailSendService.escapeAttr(trackingUrl)}"`;
    });

    // 2. Inyectar pixel de apertura
    const openTrackingUrl = `${baseUrl}/api/tracking/email?m=${messageId}&a=open`;
    const trackingPixel = `<img src="${EmailSendService.escapeAttr(openTrackingUrl)}" width="1" height="1" style="display:none !important; visibility:hidden !important; opacity:0 !important;" alt="" />`;
    
    if (modifiedHtml.includes('</body>')) {
      modifiedHtml = modifiedHtml.replace('</body>', `${trackingPixel}</body>`);
    } else {
      modifiedHtml += trackingPixel;
    }

    return modifiedHtml;
  }

  /**
   * Registra una apertura de correo.
   */
  static async trackOpen(messageId: string, metadata: { ip?: string; ua?: string }): Promise<void> {
    if (!messageId || !isValidUUID(messageId)) return;

    try {
      const { data: message, error: fetchError } = await supabaseAdmin
        .from('messages')
        .select('interaction')
        .eq('id', messageId)
        .single();

      if (fetchError || !message) {
        console.error('[EmailTrackingService] Error fetching message for tracking:', fetchError);
        return;
      }

      const interaction: MessageInteraction = (message.interaction as unknown as MessageInteraction) || {
        open_count: 0,
        click_count: 0,
        opens: [],
        clicks: []
      };

      interaction.open_count = (interaction.open_count || 0) + 1;
      interaction.opens = interaction.opens || [];
      interaction.opens.push({
        at: new Date().toISOString(),
        ...metadata
      });

      await supabaseAdmin
        .from('messages')
        .update({ interaction: interaction as any })
        .eq('id', messageId);

      console.log(`[EmailTrackingService] Open tracked for message ${messageId}`);
    } catch (error) {
      console.error('[EmailTrackingService] Unexpected error tracking open:', error);
    }
  }

  /**
   * Registra un clic en un link y crea una tarea.
   */
  static async trackClick(messageId: string, url: string, metadata: { ip?: string; ua?: string }): Promise<void> {
    if (!messageId || !isValidUUID(messageId)) return;

    try {
      const { data: message, error: fetchError } = await supabaseAdmin
        .from('messages')
        .select('id, interaction, lead_id, site_id, user_id, conversation_id, content')
        .eq('id', messageId)
        .single();

      if (fetchError || !message) {
        console.error('[EmailTrackingService] Error fetching message for tracking click:', fetchError);
        return;
      }

      const interaction: MessageInteraction = (message.interaction as unknown as MessageInteraction) || {
        open_count: 0,
        click_count: 0,
        opens: [],
        clicks: []
      };

      interaction.click_count = (interaction.click_count || 0) + 1;
      interaction.clicks = interaction.clicks || [];
      interaction.clicks.push({
        at: new Date().toISOString(),
        url,
        ...metadata
      });

      await supabaseAdmin
        .from('messages')
        .update({ interaction: interaction as any })
        .eq('id', messageId);

      console.log(`[EmailTrackingService] Click tracked for message ${messageId} to URL ${url}`);

      // Crear tarea para el clic
      if (message.lead_id && message.site_id) {
        await createTask({
          title: 'Email link clicked',
          description: `A link was clicked in an email.\n\nURL: ${url}\nMessage ID: ${messageId}\nMessage Content Snippet: ${message.content?.substring(0, 100)}...`,
          type: 'email_interaction',
          status: 'pending',
          priority: 1,
          user_id: message.user_id || '',
          site_id: message.site_id,
          lead_id: message.lead_id,
          conversation_id: message.conversation_id
        });
        console.log(`[EmailTrackingService] Task created for click on message ${messageId}`);
      }
    } catch (error) {
      console.error('[EmailTrackingService] Unexpected error tracking click:', error);
    }
  }
}
