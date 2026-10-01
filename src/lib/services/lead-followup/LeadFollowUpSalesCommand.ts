import { CommandFactory } from '@/lib/agentbase';

interface SalesCommandInput {
  siteId: string;
  userId: string;
  agentId?: string;
  availableChannels: string[];
  context: string;
}

/** Keep the sales command schema separate from request and generation orchestration. */
export function createLeadFollowUpSalesCommand({ siteId, userId, agentId, availableChannels, context }: SalesCommandInput) {
  return CommandFactory.createCommand({
    task: 'lead follow-up strategy',
    userId,
    agentId,
    agentRole: 'Sales/CRM Specialist',
    site_id: siteId,
    description: `Generate a personalized follow-up message for a qualified lead, focusing on addressing their pain points and interests, with appropriate timing between touchpoints. You want to delight and nurture the lead.

CRITICAL VALIDATION RULES:
- MANDATORY: title and message must be non-empty strings with actual content. NEVER return empty title or message fields.
- CHANNEL VALIDATION: You MUST select ONLY from these configured channels: ${availableChannels.join(', ')}. If the lead lacks required contact info for a channel (e.g., no email for email channel, no phone for whatsapp), you MUST select the valid alternative from the configured channels.
- SINGLE CHANNEL: Based on the lead's history, profile and context, select ONLY the most effective channel to avoid harassing the user. Choose only 1 channel from the available ones, the one with the highest probability of success according to the lead's context.
- ERROR PREVENTION: If you select an invalid channel or return empty fields, the system will fail. Be precise and validate your output.`,
    targets: [
      {
        deep_thinking: `Analyze the lead information, their interaction history, preferences, and profile to determine the single most effective communication channel.

VALIDATION CHECKLIST:
1. Review configured channels: ${availableChannels.join(', ')}
2. Verify lead has required contact info for selected channel (email for email channel, phone for whatsapp)
3. If selected channel is not available, choose valid alternative from configured channels
4. Consider factors like: lead's communication preferences, previous interactions, urgency level, lead stage, and professional context
5. Choose only ONE channel to avoid overwhelming the lead
6. Ensure you can generate meaningful, non-empty title and message content for the selected channel`
      },
      {
        follow_up_content: {
          strategy: "comprehensive sale strategy based on lead analysis",
          message_language: "language for the message content (e.g., 'en', 'es', 'fr')",
          title: "compelling title or subject line for the selected channel (MANDATORY: must be non-empty string with actual content)",
          message: "personalized message content optimized for the chosen channel (MANDATORY: must be non-empty string with actual content)",
          channel: `the single most effective channel selected - MUST be one of: ${availableChannels.join(', ')}. Validate that lead has required contact info for this channel.`
        }
      }
    ],
    context,
    model: 'openai:gpt-5.6-sol',
    supervisor: [
      {
        agent_role: 'sales_manager',
        status: 'not_initialized'
      },
      {
        agent_role: 'customer_success',
        status: 'not_initialized'
      }
    ],
    tools: [
      {
        type: "function",
        async: true,
        function: {
          name: 'QUALIFY_LEAD',
          description: 'Qualify or update lead status based on interaction outcome and company policy',
          parameters: {
            type: 'object',
            properties: {
              site_id: {
                type: 'string',
                description: 'Site UUID where the lead belongs (required)',
                ...(siteId ? { enum: [siteId] } : {})
              },
              lead_id: {
                type: 'string',
                description: 'Lead UUID to qualify (one of lead_id, email, or phone is required)'
              },
              email: {
                type: 'string',
                description: 'Lead email as alternative identifier'
              },
              phone: {
                type: 'string',
                description: 'Lead phone as alternative identifier'
              },
              status: {
                type: 'string',
                enum: ['contacted', 'qualified', 'converted', 'lost'],
                description: 'New lead status according to company rules'
              },
              notes: {
                type: 'string',
                description: 'Short reasoning for the qualification change'
              }
            },
            required: ['site_id', 'status'],
            oneOf: [
              { required: ['lead_id'] },
              { required: ['email'] },
              { required: ['phone'] }
            ],
            additionalProperties: false
          },
          strict: true
        }
      }
    ]
  });
}