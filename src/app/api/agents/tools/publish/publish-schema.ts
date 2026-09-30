import { DEFAULT_TIKTOK_OPTIONS } from './tiktok-options';

export const publishToolDefinition = {
    name: 'publish',
    description: `Consolidated tool to publish content. Can perform one or more of the following actions simultaneously:
1. Create/Update Content in DB: Requires 'title' and 'type' (to create) OR 'content_id' (to update).
2. Publish to Social Media: First call social_media_accounts and use its exact account IDs in 'social_accounts'. Never invent IDs or pass platform names as account IDs. Legacy platform selectors are resolved server-side only when unambiguous. A lookup failure or rejected identifier does not mean accounts are disconnected.
3. Reply to an Instagram DM: Requires 'instagram_dm.conversation_id'. Supports text, public HTTPS media URLs, uploaded asset IDs, and native scheduling with 'instagram_dm.scheduled_at'.
4. Send to Audience: Requires 'audience_id' and 'channel' ('whatsapp', 'telegram', 'sms', 'voice', or 'email'). (Newsletters MUST use channel: "email" and audience_email_mode: "newsletter".)
For Voice, voice_mode "tts" sends a one-way spoken message and "agent_call" starts a two-way Zavu voice-agent call. agent_call also accepts a private objective and additional_context; these guide the conversation and are not spoken as the greeting.

You MUST provide at least valid 'text', 'assets' (uploaded Outstand media IDs), 'urls', 'media_urls', or 'instagram_dm.media_urls'. For social posts attach images/videos using media_urls from trusted public storage, or uploaded assets. Ordinary urls are text links; recognized image/video urls are attached for compatibility. Instagram/TikTok cannot publish a link-only caption.
When TikTok is selected, the tool automatically uploads external trusted media to Outstand and confirms it before posting (64 MiB per file). Already hosted Outstand media is reused. Do not ask the user to verify our storage domain. The configured default is DIRECT_POST with PUBLIC_TO_EVERYONE. If the user asks to publish without specifying mode or privacy, omit tiktok or use these defaults; do not ask for a choice just because parameters are absent. Explicit tiktok.postMode and privacyLevel override the defaults: preserve requested privacy, including SELF_ONLY, and use MEDIA_UPLOAD only when an inbox draft is requested. MEDIA_UPLOAD requires the creator to publish manually. If the provider rejects public visibility, report that restriction; never silently switch privacy or modes. Outstand's documented API does not expose a creator-info endpoint, so do not invent one or claim the default was live-verified.
Social delivery status pending/scheduled means accepted, NOT published. Report success as published only for status published. For failed, partial_failure, or unknown status, inspect the existing provider post before retrying. Reuse content_id after a confirmed rejection instead of creating duplicate content. Never automatically resend when retry_safe is false.
If sending email to audience, 'subject' is required.

**TEST MODE (HIGHLY RECOMMENDED FOR DRAFTS/PREVIEWS):**
Set \`is_test: true\` to safely simulate the publishing actions without modifying the database or making external API calls. If you also provide a \`test_recipient\` (email address or phone number), the tool will send a single real test message to that recipient instead of a bulk audience send.
For personalized previews, pass \`test_lead_id\`; the tool resolves merge fields from that lead and uses its email or phone when \`test_recipient\` is omitted. A test containing merge fields is rejected when no valid test lead is provided.

CRITICAL USAGE EXAMPLES (AVOID DUPLICATE RECORDS):
- Scenario A (Same text across channels): If publishing the exact SAME text to a blog and social media, make ONE SINGLE tool call providing 'title', 'type', 'text', and 'social_accounts'.
- Scenario B (Different texts for different channels): If the content differs (e.g. long text for blog, short teaser for LinkedIn), make MULTIPLE sequential tool calls:
  - Call 1 (Blog): Provide 'title', 'type: "blog_post"', and the long 'text'.
  - Call 2 (LinkedIn): Provide ONLY 'social_accounts' with the LinkedIn account ID returned by social_media_accounts, and the short 'text'. DO NOT provide 'title' and 'type' again unless you explicitly intend to create a brand new separate database record for the teaser. Never reuse 'type: "blog_post"' for a social teaser.
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
        assets: { type: 'array', items: { type: 'string' }, description: 'Uploaded Outstand media IDs; resolved to URL and filename before posting.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Text links. For social posts, recognized image/video URLs are attached as media.' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Social post image/video URLs from trusted public storage. TikTok uploads these to Outstand automatically before sending. Maximum 64 MiB per file.' },

        // Social
        social_accounts: { type: 'array', items: { type: 'string' }, description: 'Exact connected account IDs from social_media_accounts. All targets must belong to the current site and be active. Never invent IDs.' },
        scheduledAt: { type: 'string', description: 'ISO 8601 date to schedule social post (optional).' },
        tiktok: {
          type: 'object',
          description: 'Optional TikTok overrides. Defaults to DIRECT_POST with PUBLIC_TO_EVERYONE. Explicit privacy or inbox-draft mode takes precedence; never silently change it after a provider rejection.',
          default: DEFAULT_TIKTOK_OPTIONS,
          properties: {
            postMode: { type: 'string', enum: ['DIRECT_POST', 'MEDIA_UPLOAD'], default: DEFAULT_TIKTOK_OPTIONS.postMode },
            privacyLevel: { type: 'string', enum: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'], description: 'DIRECT_POST only; defaults to PUBLIC_TO_EVERYONE when omitted. Set explicitly to override visibility. Omit for MEDIA_UPLOAD. The provider enforces account eligibility.' },
          },
          additionalProperties: false,
        },
        instagram_dm: {
          type: 'object',
          description: 'Reply to an existing Instagram conversation. Instagram does not allow initiating arbitrary DMs.',
          properties: {
            conversation_id: { type: 'string', description: 'Outstand conversation ID returned by the Conversations API or webhook.' },
            media_urls: { type: 'array', items: { type: 'string' }, description: 'Optional public HTTPS media URLs.' },
            scheduled_at: { type: 'string', description: 'Optional future ISO 8601 delivery time. It must remain inside Instagram’s 24-hour reply window.' },
          },
          required: ['conversation_id'],
        },

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
};
