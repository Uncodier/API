import { createContentCore } from '../content/create/core';
import { updateContentCore } from '../content/update/route';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { sendBulkMessagesTool } from '../sendBulkMessages/assistantProtocol';
import { sendEmailCore } from '../sendEmail/route';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { getLeadById } from '@/lib/database/lead-db';
import {
  fetchSiteNameForMerge,
  personalizeMergeTemplate,
  placeholderPolicyToMergePolicy,
} from '@/lib/messaging/lead-merge-fields';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MERGE_TOKEN_RE = /\{\{[^{}]+\}\}/;

export interface PublishToolParams {
  // Test Mode
  is_test?: boolean;
  test_recipient?: string; // optional email or phone override for testing
  test_lead_id?: string; // lead identity used for merge fields and default destination

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
  channel?: 'whatsapp' | 'email' | 'telegram' | 'sms' | 'voice';
  /** Voice only: one-way TTS or a two-way Zavu voice-agent call. */
  voice_mode?: 'tts' | 'agent_call';
  /** Voice agent only: private goal for each call. */
  objective?: string;
  /** Voice agent only: private supporting context for each call. */
  additional_context?: string;
  /** When channel is email: `mail` (default) queues via conversations; `newsletter` sends immediately with open/click tracking and no conversations. */
  audience_email_mode?: 'mail' | 'newsletter';
  subject?: string;
  from?: string;
  /** Stored as content.metadata.placeholders.when_unresolved for merge-field policy. */
  placeholders_when_unresolved?: 'strip_tokens' | 'skip_recipient';
}

export function publishTool(siteId: string, userId?: string, instanceId?: string) {
  const execute = async (args: PublishToolParams) => {
    const {
      is_test,
      test_recipient,
      test_lead_id,
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
      voice_mode,
      objective,
      additional_context,
      audience_email_mode,
      subject,
      from,
      placeholders_when_unresolved,
    } = args;

    // Validation 1: Must have at least some content
    if (!text && (!assets || assets.length === 0) && (!urls || urls.length === 0)) {
      return { success: false, error: 'Must provide at least text, assets, or urls.' };
    }

    // Validation 2: Must perform at least one action
    const willSaveContent = !!title && !!type;
    const willUpdateContent = !!content_id;
    const willPublishSocial = !!social_accounts && social_accounts.length > 0;
    const willSendAudience =
      (!!audience_id && !!channel)
      || (Boolean(is_test) && Boolean(test_recipient || test_lead_id) && !!channel);

    if (!willSaveContent && !willUpdateContent && !willPublishSocial && !willSendAudience) {
      return { 
        success: false, 
        error: 'Must specify parameters for at least one action: create/update content (title+type or content_id), publish social (social_accounts), or send audience (audience_id+channel).' 
      };
    }

    // Validation 3: Channel specific
    let finalSubject = subject;
    if (willSendAudience) {
      if (channel === 'email' && !finalSubject) {
        if (title) {
          finalSubject = title;
        } else if (is_test) {
          finalSubject = 'Test Email';
        } else {
          return { success: false, error: 'Subject is required for email audience sending.' };
        }
      }
      if (audience_email_mode === 'newsletter' && channel !== 'email') {
        return {
          success: false,
          error: 'audience_email_mode "newsletter" is only valid when channel is "email".',
        };
      }
      if (voice_mode === 'agent_call' && channel !== 'voice') {
        return {
          success: false,
          error: 'voice_mode "agent_call" is only valid when channel is "voice".',
        };
      }
      if ((objective || additional_context) && (channel !== 'voice' || voice_mode !== 'agent_call')) {
        return {
          success: false,
          error: 'objective and additional_context are only valid for Voice agent calls.',
        };
      }
    }

    // Extra Validation for Social publish: Ensure the accounts array isn't just an empty string or hallucinated format.
    if (willPublishSocial) {
      if (social_accounts.some(acc => typeof acc !== 'string' || acc.trim() === '')) {
         return { success: false, error: 'Invalid social_accounts provided. Must be an array of non-empty strings (e.g. ["linkedin", "x"]).' };
      }
    }

    // All-or-Nothing strict validation
    // If the tool call fails ANY of the conditional validations above, we have ALREADY returned { success: false, error: ... }
    // Thus, by reaching this point, we are guaranteed that if a specific action was requested, all of its required parameters are valid.
    const results: any = { success: true, actions_attempted: [] };
    if (is_test) {
      results.test_mode = true;
      results.note = "Running in TEST MODE. No real DB changes, social posts, or bulk sends were made.";
    }
    
    let finalContentId = content_id;
    
    // Prepare metadata
    const metadata: Record<string, unknown> = {};
    if (assets && assets.length > 0) metadata.assets = assets;
    if (urls && urls.length > 0) metadata.urls = urls;
    if (placeholders_when_unresolved) {
      metadata.placeholders = {
        ...(typeof metadata.placeholders === 'object' && metadata.placeholders !== null
          ? (metadata.placeholders as object)
          : {}),
        when_unresolved: placeholders_when_unresolved,
      };
    }

    // --- 1. Content DB (Save/Update) ---
    if (willSaveContent || willUpdateContent) {
      results.actions_attempted.push('content');
      try {
        let contentResult;
        
        if (is_test) {
          finalContentId = content_id || 'test-content-uuid-1234';
          results.content = { success: true, id: finalContentId, simulated: true };
        } else {
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
        }
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
        if (is_test) {
          results.social = { success: true, simulated: true, message: `Would have published to: ${social_accounts.join(', ')}` };
        } else {
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
        }
      } catch (error: any) {
        results.social = { success: false, error: error.message };
        results.success = false; // Mark overall as partial failure
      }
    }

    // --- 3. Audience Send ---
    if (willSendAudience) {
      results.actions_attempted.push('audience');
      try {
        if (is_test) {
          if (test_recipient || test_lead_id) {
            const legacyLeadId =
              test_recipient && UUID_RE.test(test_recipient) ? test_recipient : undefined;
            const resolvedLeadId = test_lead_id || legacyLeadId;
            const lead = resolvedLeadId ? await getLeadById(resolvedLeadId) : null;

            if (resolvedLeadId && (!lead || lead.site_id !== siteId)) {
              throw new Error(`Test lead ${resolvedLeadId} was not found for this site`);
            }

            const explicitRecipient = legacyLeadId ? undefined : test_recipient;
            const testEmail = explicitRecipient || lead?.email || '';
            const testPhone = explicitRecipient || lead?.phone || '';
            const hasMergeTokens =
              MERGE_TOKEN_RE.test(publishText)
              || MERGE_TOKEN_RE.test(finalSubject || '');

            if (hasMergeTokens && !lead) {
              throw new Error(
                'A valid test_lead_id is required when a test message contains merge fields',
              );
            }

            // Dispatch a single test message
          if (channel === 'email') {
            if (!testEmail) {
              throw new Error(`Test lead ${resolvedLeadId} has no email address`);
            }
            const testEmailResult = await sendEmailCore({
              site_id: siteId,
              email: testEmail,
              lead_id: resolvedLeadId,
              subject: `[TEST] ${finalSubject || 'Test Subject'}`,
              message: publishText,
              from,
              instance_id: instanceId,
              omit_signature: audience_email_mode === 'newsletter',
              placeholder_policy: placeholders_when_unresolved,
            });
            results.audience = { success: testEmailResult.success, type: 'single_test_send', result: testEmailResult };
            if (!testEmailResult.success) results.success = false;
          } else if (channel === 'whatsapp' || channel === 'sms') {
            if (!testPhone) {
              throw new Error(`Test lead ${resolvedLeadId} has no phone number`);
            }
            let personalizedText = publishText;
            if (lead) {
              const siteName = await fetchSiteNameForMerge(siteId);
              const merged = personalizeMergeTemplate(
                publishText,
                lead,
                siteName,
                placeholderPolicyToMergePolicy(placeholders_when_unresolved),
              );
              if (merged.aborted) {
                throw new Error(`Unresolved merge fields: ${merged.unresolved.join(', ')}`);
              }
              personalizedText = merged.text;
            }
            const testWaResult = await WhatsAppSendService.sendMessage({
              site_id: siteId,
              phone_number: testPhone,
              message: `[TEST] ${personalizedText}`,
              from,
              lead_id: resolvedLeadId,
              media_urls: urls, // Fallback media for WA
            });
            results.audience = { success: testWaResult.success, simulated: true, type: 'single_test_send', result: testWaResult };
            if (!testWaResult.success) results.success = false;
          } else {
            results.audience = { success: true, simulated: true, message: `Would have sent a single test to ${test_recipient} via ${channel}` };
          }
          } else {
            results.audience = { success: true, simulated: true, message: `Would have executed bulk send to audience ${audience_id} via ${channel}` };
          }
        } else {
          const bulkSender = sendBulkMessagesTool(siteId);
          
          const audienceResult = await bulkSender.execute({
            audience_id: audience_id as string, // willSendAudience and !is_test ensures audience_id exists
            channel: channel as 'whatsapp' | 'email' | 'telegram' | 'sms' | 'voice',
            message: publishText, // We send the combined text + urls
            ...(finalSubject ? { subject: finalSubject } : {}),
            ...(from ? { from } : {}),
            ...(audience_email_mode ? { audience_email_mode } : {}),
            ...(voice_mode ? { voice_mode } : {}),
            ...(objective ? { objective } : {}),
            ...(additional_context ? { additional_context } : {}),
            ...(finalContentId ? { content_id: finalContentId } : {}),
          });

          results.audience = audienceResult;
          if (!audienceResult.success) {
            results.success = false;
          }
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
2. Publish to Social Media: Requires 'social_accounts' array (e.g. ['linkedin', 'x', 'facebook', 'instagram', 'tiktok', 'youtube', 'threads', 'pinterest', 'bluesky']). DO NOT hallucinate parameters like 'networks'.
3. Send to Audience: Requires 'audience_id' and 'channel' ('whatsapp', 'telegram', 'sms', 'voice', or 'email'). (Newsletters MUST use channel: "email" and audience_email_mode: "newsletter".)
For Voice, voice_mode "tts" sends a one-way spoken message and "agent_call" starts a two-way Zavu voice-agent call. agent_call also accepts a private objective and additional_context; these guide the conversation and are not spoken as the greeting.

You MUST provide at least valid 'text', 'assets' (array of media IDs), or 'urls'. DO NOT hallucinate parameters like 'media_urls'.
If sending email to audience, 'subject' is required.

**TEST MODE (HIGHLY RECOMMENDED FOR DRAFTS/PREVIEWS):**
Set \`is_test: true\` to safely simulate the publishing actions without modifying the database or making external API calls. If you also provide a \`test_recipient\` (email address or phone number), the tool will send a single real test message to that recipient instead of a bulk audience send.
For personalized previews, pass \`test_lead_id\`; the tool resolves merge fields from that lead and uses its email or phone when \`test_recipient\` is omitted. A test containing merge fields is rejected when no valid test lead is provided.

CRITICAL USAGE EXAMPLES (AVOID DUPLICATE RECORDS):
- Scenario A (Same text across channels): If publishing the exact SAME text to a blog and social media, make ONE SINGLE tool call providing 'title', 'type', 'text', and 'social_accounts'.
- Scenario B (Different texts for different channels): If the content differs (e.g. long text for blog, short teaser for LinkedIn), make MULTIPLE sequential tool calls:
  - Call 1 (Blog): Provide 'title', 'type: "blog_post"', and the long 'text'.
  - Call 2 (LinkedIn): Provide ONLY 'social_accounts: ["linkedin"]' and the short 'text'. DO NOT provide 'title' and 'type' again unless you explicitly intend to create a brand new separate database record for the teaser. Never reuse 'type: "blog_post"' for a social teaser.
  - Alternatively, if you want both to share the same DB record, pass the 'content_id' returned from Call 1 into Call 2 instead of 'title' and 'type'.

For email audience sends, optional 'audience_email_mode': 'mail' (default) queues one conversation + approved message per lead for background delivery; 'newsletter' sends immediately with open/click tracking (same as sendEmail), **without** appending an email signature, and does not create conversations. Only valid when channel is 'email'.

For WhatsApp audience sends, a SINGLE Twilio Content Template is created (or reused) for the whole campaign: merge tokens in the body become numeric placeholders ({{1}}, {{2}}, ...) and each lead is queued with its own ContentVariables. You do NOT need a separate template per recipient — per-lead personalization happens at delivery time via variables.

Optional 'placeholders_when_unresolved' (with create/update content in the same call) stores metadata.placeholders.when_unresolved on the content row: strip_tokens (default behavior) removes unknown {{...}} tokens per lead; skip_recipient skips that lead. Use double-brace merge tokens only: {{lead.name}}, {{lead.first_name}}, {{lead.email}}, {{lead.phone}}, {{lead.position}}, {{lead.company}}, {{lead.notes}}, {{lead.metadata.<path>}}, {{site.name}}. When content is saved in the same publish call, its id is passed to the audience send so that policy applies. For WhatsApp this policy controls the ContentVariables fallback when a lead is missing a merge value.

The tool will return an object detailing the success/failure of each attempted action.`,
    parameters: {
      type: 'object',
      properties: {
        // Test Mode
        is_test: { type: 'boolean', description: 'Run the tool in test mode. Bypasses actual DB saves, social posting, and bulk sending.' },
        test_recipient: { type: 'string', description: 'Optional email or phone override for a single real test send.' },
        test_lead_id: { type: 'string', description: 'Lead UUID used to resolve merge fields and, by default, the test email or phone destination.' },

        // Content DB
        content_id: { type: 'string', description: 'ID of existing content to update (optional).' },
        title: { type: 'string', description: 'Title of content (required for create).' },
        type: { type: 'string', description: 'Type of content (e.g., social_post, blog_post) (required for create).' },
        
        // Data
        text: { type: 'string', description: 'Main text content.' },
        assets: { type: 'array', items: { type: 'string' }, description: 'Array of media asset IDs.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Array of URLs to include.' },

        // Social
        social_accounts: { type: 'array', items: { type: 'string' }, description: 'Social account identifiers to publish to (e.g. ["linkedin", "x", "facebook", "instagram", "tiktok", "youtube", "threads", "pinterest", "bluesky"]).' },
        scheduledAt: { type: 'string', description: 'ISO 8601 date to schedule social post (optional).' },

        // Audience
        audience_id: { type: 'string', description: 'Audience UUID to send to.' },
        channel: { type: 'string', enum: ['whatsapp', 'email', 'telegram', 'sms', 'voice'], description: 'Channel for audience send.' },
        voice_mode: {
          type: 'string',
          enum: ['tts', 'agent_call'],
          description: 'Voice only. tts is a one-way spoken message; agent_call starts a two-way Zavu voice-agent call.',
        },
        objective: {
          type: 'string',
          maxLength: 500,
          description: 'Voice agent calls only. Private goal for the call; it is not spoken as the greeting.',
        },
        additional_context: {
          type: 'string',
          maxLength: 4000,
          description: 'Voice agent calls only. Private supporting context for the agent.',
        },
        audience_email_mode: {
          type: 'string',
          enum: ['mail', 'newsletter'],
          description: 'Email audience only: mail (default) queues via conversations; newsletter sends immediately with tracking, no conversations.',
        },
        subject: { type: 'string', description: 'Subject for email audience send.' },
        from: { type: 'string', description: 'Sender display name for audience.' },
        placeholders_when_unresolved: {
          type: 'string',
          enum: ['strip_tokens', 'skip_recipient'],
          description:
            'When creating/updating content for the same publish call: store merge policy for unknown {{...}} tokens in content.metadata.placeholders.when_unresolved.',
        },
      }
    },
    execute
  };
}
