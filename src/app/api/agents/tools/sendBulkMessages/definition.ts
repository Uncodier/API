export const SEND_BULK_MESSAGES_DESCRIPTION = `Send a message to all leads in an audience via WhatsApp, email, telegram, sms or voice.

Required: audience_id, channel ("whatsapp", "email", "telegram", "sms", or "voice"), message.
For email: subject is also required.
Optional: from, content_id (content UUID whose metadata.placeholders.when_unresolved controls unknown merge tokens), placeholder_policy (override), audience_email_mode.
For Voice: voice_mode is "tts" (default, one-way message) or "agent_call" (two-way Zavu voice agent call).

Merge fields — use only double braces: {{lead.name}}, {{lead.first_name}}, {{lead.email}}, {{lead.phone}}, {{lead.position}}, {{lead.company}}, {{lead.notes}}, {{lead.metadata.<key>}}, {{site.name}}. Common aliases (e.g. {{lead.correo}}, {{lead.full_name}}) are normalized. Other syntaxes ([Name], {name}) are not supported.

For email only: audience_email_mode — "mail" (default) or "newsletter".

The tool iterates through every lead in the audience:
- WhatsApp/SMS/Voice: requires lead.phone (international format). Leads without phone are skipped.
- Email: requires lead.email. Leads without email are skipped.
- Telegram: requires lead.phone or telegram ID (currently uses phone logic).

WhatsApp delivery:
- Creates (or reuses) ONE Twilio Content Template per campaign whose body uses numeric placeholders ({{1}}, {{2}}, ...). Merge tokens in the message are mapped to those placeholders.
- For each lead, queues one conversation + accepted message row that stores template_sid and the per-lead content_variables map; a background worker delivers via ContentVariables so a single approved template serves the whole audience.
- Returns template_sid, template_status, and placeholder_map alongside the counters.

Email delivery modes:
- mail (default): queues one conversation plus an accepted message per lead (body/subject personalized per lead); a background workflow delivers and tracks. total_sent counts queued handoffs.
- newsletter: sends immediately via sendEmail (open/click tracking), **no** HTML signature appended, no conversation rows. Large audiences may hit server timeouts — prefer smaller batches if needed.

Each lead's send_status is tracked (sent, failed, skipped) so the tool can be re-run safely — already processed leads are not re-queued.

Returns a summary: total_sent, total_failed, total_skipped, total_remaining.

IMPORTANT:
- First create an audience using the "audience" tool, then pass its audience_id here.
- The audience must have status "ready" before sending.
- Review the audience contents with audience(get) before sending to confirm the target list.`;

export const SEND_BULK_MESSAGES_PARAMETERS = {
  type: 'object',
  properties: {
    audience_id: { type: 'string', description: 'Audience UUID to send messages to.' },
    channel: {
      type: 'string',
      enum: ['whatsapp', 'email', 'telegram', 'sms', 'voice'],
      description: 'Delivery channel.',
    },
    message: { type: 'string', description: 'Message text (plain text or HTML for email).' },
    subject: { type: 'string', description: 'Email subject (required when channel is "email").' },
    from: { type: 'string', description: 'Sender display name (optional).' },
    audience_email_mode: {
      type: 'string',
      enum: ['mail', 'newsletter'],
      description: 'Email only. mail (default): queue via conversations. newsletter: send immediately with tracking, no conversations.',
    },
    content_id: {
      type: 'string',
      description:
        'Optional content UUID. When set, metadata.placeholders.when_unresolved (strip_tokens | skip_recipient) controls unknown {{...}} tokens unless placeholder_policy overrides.',
    },
    placeholder_policy: {
      type: 'string',
      enum: ['strip_tokens', 'skip_recipient'],
      description:
        'Override for unresolved merge tokens. strip_tokens: remove unknown tokens. skip_recipient: skip that lead when unknown tokens remain.',
    },
    voice_mode: {
      type: 'string',
      enum: ['tts', 'agent_call'],
      description:
        'Voice only. tts sends a one-way spoken message; agent_call starts a two-way Zavu voice-agent call.',
    },
  },
  required: ['audience_id', 'channel', 'message'],
};
