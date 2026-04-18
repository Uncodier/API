import { createContentCore } from '../content/create/route';
import { updateContentCore } from '../content/update/route';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { sendBulkMessagesTool } from '../sendBulkMessages/assistantProtocol';

export interface PublishToolParams {
  // Content DB Params
  content_id?: string;
  title?: string;
  type?: string;
  
  // Content Data
  text?: string;
  assets?: string[];
  urls?: string[];

  // Social Media Params
  social_accounts?: string[];
  scheduledAt?: string;

  // Audience Params
  audience_id?: string;
  channel?: 'whatsapp' | 'email';
  /** When channel is email: `mail` (default) queues via conversations; `newsletter` sends immediately with open/click tracking and no conversations. */
  audience_email_mode?: 'mail' | 'newsletter';
  subject?: string;
  from?: string;
}

export function publishTool(siteId: string, userId?: string, instanceId?: string) {
  const execute = async (args: PublishToolParams) => {
    const {
      content_id,
      title,
      type,
      text,
      assets,
      urls,
      social_accounts,
      scheduledAt,
      audience_id,
      channel,
      audience_email_mode,
      subject,
      from,
    } = args;

    // Validation 1: Must have at least some content
    if (!text && (!assets || assets.length === 0) && (!urls || urls.length === 0)) {
      return { success: false, error: 'Must provide at least text, assets, or urls.' };
    }

    // Validation 2: Must perform at least one action
    const willSaveContent = !!title && !!type;
    const willUpdateContent = !!content_id;
    const willPublishSocial = !!social_accounts && social_accounts.length > 0;
    const willSendAudience = !!audience_id && !!channel;

    if (!willSaveContent && !willUpdateContent && !willPublishSocial && !willSendAudience) {
      return { 
        success: false, 
        error: 'Must specify parameters for at least one action: create/update content (title+type or content_id), publish social (social_accounts), or send audience (audience_id+channel).' 
      };
    }

    // Validation 3: Channel specific
    if (willSendAudience) {
      if (channel === 'email' && !subject) {
        return { success: false, error: 'Subject is required for email audience sending.' };
      }
      if (audience_email_mode === 'newsletter' && channel !== 'email') {
        return {
          success: false,
          error: 'audience_email_mode "newsletter" is only valid when channel is "email".',
        };
      }
    }

    const results: any = { success: true, actions_attempted: [] };
    let finalContentId = content_id;
    
    // Prepare metadata
    const metadata: any = {};
    if (assets && assets.length > 0) metadata.assets = assets;
    if (urls && urls.length > 0) metadata.urls = urls;

    // --- 1. Content DB (Save/Update) ---
    if (willSaveContent || willUpdateContent) {
      results.actions_attempted.push('content');
      try {
        let contentResult;
        if (willUpdateContent) {
          contentResult = await updateContentCore({
            content_id,
            site_id: siteId,
            text,
            status: 'published',
            metadata
          });
        } else {
          contentResult = await createContentCore({
            title,
            type,
            site_id: siteId,
            user_id: userId,
            text,
            status: 'published',
            metadata
          });
          finalContentId = contentResult.id;
        }
        results.content = { success: true, id: finalContentId };
      } catch (error: any) {
        results.content = { success: false, error: error.message };
        results.success = false;
      }
    }

    // Prepare text with urls/assets for publishing if needed
    let publishText = text || '';
    if (urls && urls.length > 0) {
      publishText += '\n\n' + urls.join('\n');
    }
    
    // For social media, Outstand handles media directly if we pass containers, but we'll try to map assets
    let outstandContainers = undefined;
    if (assets && assets.length > 0) {
       outstandContainers = [{
          content: publishText,
          media: assets.map(id => ({ id }))
       }];
    }

    // --- 2. Social Media Publish ---
    if (willPublishSocial) {
      results.actions_attempted.push('social');
      try {
        const client = getOutstandClient();
        
        const payload: any = {
          accounts: social_accounts,
          ...(scheduledAt ? { scheduledAt } : {}),
        };

        if (outstandContainers) {
           payload.containers = outstandContainers;
        } else {
           payload.content = publishText;
        }

        const socialResult = await client.createPost(payload, siteId);
        results.social = { success: true, result: socialResult };
      } catch (error: any) {
        results.social = { success: false, error: error.message };
        results.success = false; // Mark overall as partial failure
      }
    }

    // --- 3. Audience Send ---
    if (willSendAudience) {
      results.actions_attempted.push('audience');
      try {
        const bulkSender = sendBulkMessagesTool(siteId);
        
        const audienceResult = await bulkSender.execute({
          audience_id,
          channel: channel as 'whatsapp' | 'email',
          message: publishText, // We send the combined text + urls
          ...(subject ? { subject } : {}),
          ...(from ? { from } : {}),
          ...(audience_email_mode ? { audience_email_mode } : {}),
        });

        results.audience = audienceResult;
        if (!audienceResult.success) {
           results.success = false;
        }
      } catch (error: any) {
        results.audience = { success: false, error: error.message };
        results.success = false;
      }
    }

    return results;
  };

  return {
    name: 'publish',
    description: `Consolidated tool to publish content. Can perform one or more of the following actions simultaneously:
1. Create/Update Content in DB: Requires 'title' and 'type' (to create) OR 'content_id' (to update).
2. Publish to Social Media: Requires 'social_accounts' array (e.g. ['linkedin', 'twitter']).
3. Send to Audience: Requires 'audience_id' and 'channel' ('whatsapp' or 'email').

You MUST provide at least valid 'text', 'assets' (array of media IDs), or 'urls'.
If sending email to audience, 'subject' is required.

For email audience sends, optional 'audience_email_mode': 'mail' (default) queues one conversation + approved message per lead for background delivery; 'newsletter' sends immediately with open/click tracking (same as sendEmail) and does not create conversations. Only valid when channel is 'email'.

The tool will return an object detailing the success/failure of each attempted action.`,
    parameters: {
      type: 'object',
      properties: {
        // Content DB
        content_id: { type: 'string', description: 'ID of existing content to update (optional).' },
        title: { type: 'string', description: 'Title of content (required for create).' },
        type: { type: 'string', description: 'Type of content (e.g., social_post, blog_post) (required for create).' },
        
        // Data
        text: { type: 'string', description: 'Main text content.' },
        assets: { type: 'array', items: { type: 'string' }, description: 'Array of media asset IDs.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Array of URLs to include.' },

        // Social
        social_accounts: { type: 'array', items: { type: 'string' }, description: 'Social account identifiers to publish to.' },
        scheduledAt: { type: 'string', description: 'ISO 8601 date to schedule social post (optional).' },

        // Audience
        audience_id: { type: 'string', description: 'Audience UUID to send to.' },
        channel: { type: 'string', enum: ['whatsapp', 'email'], description: 'Channel for audience send.' },
        audience_email_mode: {
          type: 'string',
          enum: ['mail', 'newsletter'],
          description: 'Email audience only: mail (default) queues via conversations; newsletter sends immediately with tracking, no conversations.',
        },
        subject: { type: 'string', description: 'Subject for email audience send.' },
        from: { type: 'string', description: 'Sender display name for audience.' }
      }
    },
    execute
  };
}
