import { createTask } from '@/lib/database/task-db';
import ical from 'node-ical';

export class CalendarAttachmentService {
  /**
   * Processes email attachments to find calendar events (.ics)
   * and creates tasks for them.
   */
  public static async processAttachments(
    attachments: any[],
    siteId: string,
    userId?: string,
    leadId?: string,
    conversationId?: string
  ): Promise<string[]> {
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }

    let finalUserId = userId;
    if (!finalUserId && siteId) {
      const { supabaseAdmin } = await import('@/lib/database/supabase-server');
      const { data: site } = await supabaseAdmin.from('sites').select('user_id').eq('id', siteId).single();
      if (site) {
        finalUserId = site.user_id;
      }
    }

    if (!finalUserId) {
      console.warn('[CalendarAttachmentService] No user_id found, skipping task creation.');
      return [];
    }

    const createdTaskIds: string[] = [];

    for (const attachment of attachments) {
      // Check if attachment is a calendar event
      const isIcs = 
        (attachment.contentType && attachment.contentType.includes('text/calendar')) ||
        (attachment.filename && attachment.filename.toLowerCase().endsWith('.ics'));

      if (!isIcs || !attachment.content) {
        continue;
      }

      try {
        // Content might be base64 from AgentMail or plain text/buffer from imapflow
        let icsData = '';
        if (Buffer.isBuffer(attachment.content)) {
          icsData = attachment.content.toString('utf-8');
        } else if (typeof attachment.content === 'string') {
          // Check if it's base64 (very basic check, might need better logic depending on source)
          if (attachment.encoding === 'base64' || /^[A-Za-z0-9+/=]+$/.test(attachment.content.replace(/\s/g, ''))) {
            try {
              icsData = Buffer.from(attachment.content, 'base64').toString('utf-8');
            } catch (e) {
              icsData = attachment.content; // Fallback to raw string
            }
          } else {
            icsData = attachment.content;
          }
        }

        if (!icsData) {
          continue;
        }

        // Parse ICS data
        const events = await ical.async.parseICS(icsData);
        
        for (const rawEvent of Object.values(events)) {
          const event = rawEvent as any;
          if (event && event.type === 'VEVENT') {
            // Extract string values safely, handling node-ical parameter objects
            const getStringValue = (val: any): string => {
              if (!val) return '';
              if (typeof val === 'string') return val;
              if (typeof val === 'object' && val.val) return String(val.val);
              return String(val);
            };

            const title = getStringValue(event.summary) || 'Meeting / Appointment';
            const description = getStringValue(event.description);
            const location = getStringValue(event.location);
            const startDate = event.start ? new Date(event.start as any).toISOString() : new Date().toISOString();
            
            let notes = '';
            if (location) {
              notes += `Location: ${location}\n`;
            }
            const url = getStringValue(event.url);
            if (url) {
              notes += `URL: ${url}\n`;
            }
            if (event.organizer) {
              let organizerName = event.organizer.val || event.organizer;
              if (typeof organizerName === 'object') {
                organizerName = JSON.stringify(organizerName);
              }
              notes += `Organizer: ${organizerName}\n`;
            }

            // Create task for the calendar event
            const task = await createTask({
              title: `📅 ${title}`,
              description: description,
              type: 'meeting',
              status: 'pending',
              stage: 'pending',
              priority: 5, // medium
              user_id: finalUserId,
              site_id: siteId,
              lead_id: leadId,
              conversation_id: conversationId,
              scheduled_date: startDate,
              notes: notes.trim()
            });

            console.log(`[CalendarAttachmentService] Created task ${task.id} for calendar event: ${title}`);
            createdTaskIds.push(task.id);
          }
        }

      } catch (error) {
        console.error('[CalendarAttachmentService] Error processing calendar attachment:', error);
      }
    }

    return createdTaskIds;
  }
}
