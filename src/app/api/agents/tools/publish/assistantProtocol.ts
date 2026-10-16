import { publishToolDefinition } from './publish-schema';
import { createContentCore } from '../content/create/core';
import { updateContentCore } from '../content/update/core';
import { publishSocialContent } from './social-publishing';
import type { TikTokPublishInput } from './tiktok-options';
import { sendBulkMessagesTool } from '../sendBulkMessages/assistantProtocol';
import { buildToolExecutionContext, readToolExecutionContext, type ToolExecutionContext } from '@/lib/services/tool-execution-context';
import {
  type InstagramDirectMessageParams,
  publishInstagramDirectMessage,
  validateInstagramDirectMessage,
} from './instagram-dm';

import { parseDeliveryRoutes, resolveDeliveryRoutes, type DeliveryRoute, type DeliveryRoutingInput } from '@/lib/messaging/delivery-routing';
import { validateBulkRoutes } from '../sendBulkMessages/validation';
import { getAudienceById } from '@/lib/database/audience-db';
import { preparePublishTest } from './test-delivery';

export interface PublishToolParams extends DeliveryRoutingInput {
  // Test Mode
  is_test?: boolean;
  test_recipient?: string; // optional email or phone override for testing
  test_recipients?: { email?: string; phone?: string };
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
  social_account_targets?: { id: string; network: string }[];
  scheduledAt?: string;
  tiktok?: TikTokPublishInput;
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
  const execute = async (args: PublishToolParams, executionContext?: ToolExecutionContext) => {
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
      social_accounts: suppliedSocialAccounts,
      instagram_dm,
      audience_id,
      channel,
      objective,
      additional_context,
      subject,
      from,
      placeholders_when_unresolved,
    } = args;
    if (args.social_account_targets !== undefined && (!Array.isArray(args.social_account_targets)
      || args.social_account_targets.length > 100 || args.social_account_targets.some(target => !target || typeof target !== 'object'
        || typeof target.id !== 'string' || !target.id.trim() || typeof target.network !== 'string' || !target.network.trim()))) {
      return { success: false, error: 'Invalid social_account_targets.' };
    }
    const social_accounts = suppliedSocialAccounts ?? args.social_account_targets?.map(target => target.id);
    args = { ...args, ...(social_accounts ? { social_accounts } : {}) };

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
    const hasRouting = channel !== undefined || args.delivery_routes !== undefined || args.connection_id !== undefined;
    const willSendAudience = hasRouting && (!!audience_id || Boolean(is_test));
    let routes: DeliveryRoute[] = [];
    if (hasRouting) {
      try { routes = parseDeliveryRoutes(args); } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

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
      if (routes.some(route => route.channel === 'email') && !finalSubject) {
        finalSubject = title || (is_test ? 'Test Email' : undefined);
        if (!finalSubject) return { success: false, error: 'Subject is required for email audience sending.' };
      }
      if ((objective || additional_context) && !routes.some(route => route.voice_mode === 'agent_call')) {
        return { success: false, error: 'objective and additional_context are only valid for Voice agent calls.' };
      }
    }

    if (media_urls?.length && !willPublishSocial) {
      return { success: false, error: 'media_urls requires social_accounts. For Instagram DMs use instagram_dm.media_urls.' };
    }
    if (args.tiktok !== undefined && !willPublishSocial) {
      return { success: false, error: 'tiktok settings require social_accounts.' };
    }

    let testDelivery: (() => Promise<any>) | undefined;
    try {
      // Pure previews do not verify connectivity; every real send validates all routes first.
      if (hasRouting && (!is_test || test_recipient || test_lead_id || args.test_recipients)) routes = await resolveDeliveryRoutes(siteId, args);
      if (willSendAudience && !is_test) {
        validateBulkRoutes({ ...args, audience_id: audience_id!, message: text || urls?.join('\n') || '', subject: finalSubject }, routes);
        const audience = await getAudienceById(audience_id!);
        if (!audience || audience.site_id !== siteId || audience.status !== 'ready') throw new Error('Audience must be ready and belong to this site.');
      }
      if (is_test && (test_recipient || test_lead_id || args.test_recipients) && hasRouting) {
        testDelivery = await preparePublishTest(siteId, args, [text, urls?.join('\n')].filter(Boolean).join('\n\n'), finalSubject, routes);
      }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }

    // All-or-Nothing strict validation
    // If the tool call fails ANY of the conditional validations above, we have ALREADY returned { success: false, error: ... }
    // Thus, by reaching this point, we are guaranteed that if a specific action was requested, all of its required parameters are valid.
    const results: any = { success: true, actions_attempted: [] };
    if (is_test) {
      results.test_mode = true;
      results.note = testDelivery
        ? "Running in TEST MODE. Selected recipients receive real test deliveries. Voice agent calls create tracked test records; no social posts or bulk audience sends are made."
        : "Running in TEST MODE. Preview only: no real deliveries or publication changes are made.";
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
          results.audience = testDelivery ? await testDelivery() : { success: true, simulated: true, connectivity_verified: false, message: 'Audience preview only; no message sent.' };
          if (!results.audience.success) results.success = false;
        } else {
          const bulkSender = sendBulkMessagesTool(siteId);
          const inherited = readToolExecutionContext(executionContext, siteId);
          const publishedFacts = [
            typeof title === 'string' && title ? `Published title: ${title}` : undefined,
            typeof type === 'string' && type ? `Published type: ${type}` : undefined,
            publishText ? `Published text:\n${publishText}` : undefined,
          ].filter(Boolean).join('\n');
          const derivedContext = buildToolExecutionContext({
            site_id: siteId,
            intent: objective?.trim() || inherited?.intent,
            // A lead conversation is not campaign background for other recipients.
            background: additional_context?.trim() || [publishedFacts,
              inherited?.source.conversation_id || inherited?.source.message_id ? undefined : inherited?.background,
            ].filter(Boolean).join('\n\n'),
            source: {
              tool: 'publish',
              instance_id: inherited?.source.instance_id ?? instanceId,
              node_id: inherited?.source.node_id,
              content_id: finalContentId,
              audience_id,
            },
          });
          
          const audienceResult = await bulkSender.execute({
            audience_id: audience_id as string, // willSendAudience and !is_test ensures audience_id exists
            delivery_routes: routes,
            message: publishText, // We send the combined text + urls
            ...(finalSubject ? { subject: finalSubject } : {}),
            ...(from ? { from } : {}),
            ...(objective ? { objective } : {}),
            ...(additional_context ? { additional_context } : {}),
            ...(finalContentId ? { content_id: finalContentId } : {}),
          }, derivedContext);

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
