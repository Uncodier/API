import { publishToolDefinition } from './publish-schema';
import { createContentCore } from '../content/create/core';
import { updateContentCore } from '../content/update/route';
import { publishSocialContent } from './social-publishing';
import { sendBulkMessagesTool } from '../sendBulkMessages/assistantProtocol';
import { sendEmailCore } from '../sendEmail/route';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { getLeadById } from '@/lib/database/lead-db';
import {
  fetchSiteNameForMerge,
  personalizeMergeTemplate,
  placeholderPolicyToMergePolicy,
} from '@/lib/messaging/lead-merge-fields';
import {
  type InstagramDirectMessageParams,
  publishInstagramDirectMessage,
  validateInstagramDirectMessage,
} from './instagram-dm';

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
  media_urls?: string[];

  // Social Media Params
  social_accounts?: string[];
  scheduledAt?: string;
  instagram_dm?: InstagramDirectMessageParams;

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
      media_urls,
      social_accounts,
      instagram_dm,
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

    for (const [name, value] of Object.entries({ social_accounts, assets, urls, media_urls })) {
      if (value !== undefined && (!Array.isArray(value) || value.length > 100
        || Array.from(value).some((item) => typeof item !== 'string' || !item.trim()))) {
        return { success: false, error: `${name} must be an array of non-empty strings (maximum 100).` };
      }
    }
    if (social_accounts !== undefined && social_accounts.length === 0) {
      return { success: false, error: 'social_accounts must include at least one connected account ID.' };
    }

    // Validation 1: Must have at least some content
    if (
      !text
      && (!assets || assets.length === 0)
      && (!urls || urls.length === 0)
      && (!media_urls || media_urls.length === 0)
      && (!instagram_dm?.media_urls || instagram_dm.media_urls.length === 0)
    ) {
      return { success: false, error: 'Must provide at least text, assets, urls, or media_urls.' };
    }

    // Validation 2: Must perform at least one action
    const willSaveContent = !!title && !!type;
    const willUpdateContent = !!content_id;
    const willPublishSocial = !!social_accounts && social_accounts.length > 0;
    const willSendInstagramDm = !!instagram_dm;
    const willSendAudience =
      (!!audience_id && !!channel)
      || (Boolean(is_test) && Boolean(test_recipient || test_lead_id) && !!channel);

    if (!willSaveContent && !willUpdateContent && !willPublishSocial && !willSendInstagramDm && !willSendAudience) {
      return { 
        success: false, 
        error: 'Must specify parameters for at least one action: create/update content, publish social, reply to an Instagram DM, or send an audience.'
      };
    }

    const instagramDmError = validateInstagramDirectMessage(
      instagram_dm,
      text,
      assets,
      urls,
    );
    if (instagramDmError) return { success: false, error: instagramDmError };

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

    if (media_urls?.length && !willPublishSocial) {
      return { success: false, error: 'media_urls requires social_accounts. For Instagram DMs use instagram_dm.media_urls.' };
    }

    // All-or-Nothing strict validation
    // If the tool call fails ANY of the conditional validations above, we have ALREADY returned { success: false, error: ... }
    // Thus, by reaching this point, we are guaranteed that if a specific action was requested, all of its required parameters are valid.
    const results: any = { success: true, actions_attempted: [] };
    if (is_test) {
      results.test_mode = true;
      results.note = "Running in TEST MODE. No real DB changes, social posts, direct messages, or bulk sends were made.";
    }
    
    let finalContentId = content_id;
    
    // Prepare metadata
    const metadata: Record<string, unknown> = {};
    if (assets && assets.length > 0) metadata.assets = assets;
    if (urls && urls.length > 0) metadata.urls = urls;
    if (media_urls?.length) metadata.media_urls = media_urls;
    if (placeholders_when_unresolved) {
      metadata.placeholders = {
        ...(typeof metadata.placeholders === 'object' && metadata.placeholders !== null
          ? (metadata.placeholders as object)
          : {}),
        when_unresolved: placeholders_when_unresolved,
      };
    }

    // Social publishing owns validation and the content delivery lifecycle.
    if (willPublishSocial && !is_test) {
      const socialResult = await publishSocialContent(siteId, userId, args, metadata);
      Object.assign(results, socialResult);
      finalContentId = socialResult.content?.id || content_id;
      if (!socialResult.success) return results;
    }

    // Preserve content-only behavior and side-effect-free previews.
    if ((willSaveContent || willUpdateContent) && (!willPublishSocial || is_test)) {
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
      publishText = [publishText.trim(), urls.join('\n')]
        .filter(Boolean)
        .join('\n\n');
    }
    
    // Preview never performs discovery, media lookups, or live posting.
    if (willPublishSocial && is_test) {
      results.actions_attempted.push('social');
      results.social = { success: true, simulated: true, connectivity_verified: false,
        message: 'Preview only. Accounts and media have not been verified; no post was sent.' };
    }

    // --- 3. Instagram Direct Message ---
    if (willSendInstagramDm) {
      results.actions_attempted.push('instagram_dm');
      try {
        results.instagram_dm = is_test
          ? {
              success: true,
              simulated: true,
              message: `Would have replied to Instagram conversation ${instagram_dm.conversation_id}`,
            }
          : await publishInstagramDirectMessage({
              siteId,
              text: publishText,
              assetIds: assets,
              params: instagram_dm,
            });
      } catch (error: any) {
        results.instagram_dm = { success: false, error: error.message };
        results.success = false;
      }
    }

    // --- 4. Audience Send ---
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

  return { ...publishToolDefinition, execute };
}
