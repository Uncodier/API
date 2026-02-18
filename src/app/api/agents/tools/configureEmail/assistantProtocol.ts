/**
 * Assistant Protocol for Configure Email (AgentMail) Tool
 * Single tool that exposes all AgentMail configuration operations: domains, inboxes, verification.
 * Sending emails is handled by the sendEmail tool.
 */

import { configureEmailCore } from './route';
import type { ConfigureEmailAction } from './route';

export interface ConfigureEmailToolParams {
  action: ConfigureEmailAction;
  domain?: string;
  feedback_enabled?: boolean;
  username?: string;
  display_name?: string;
  client_id?: string;
  inbox_id?: string;
  domain_id?: string;
}

const ACTION_DESCRIPTION = `One of: create_domain (add a domain for sending), create_inbox (create email inbox for a domain), delete_inbox (remove an inbox), verify_domain (trigger DNS verification), check_domain_exists (check if domain is registered), get_domain_info (get domain status and DNS records), get_zone_file (get DNS zone file content).`;

/**
 * Creates the configure_email tool for OpenAI/assistant compatibility.
 * Use this to configure AgentMail: create/verify domains, create/delete inboxes, get DNS info.
 */
export function configureEmailTool(site_id: string) {
  return {
    name: 'configure_email',
    description:
      'Configure email (AgentMail): create or verify domains, create or delete inboxes, check domain existence, get domain info or DNS zone file. Required: action. Then provide the params for that action (e.g. domain and feedback_enabled for create_domain; username and domain for create_inbox; inbox_id for delete_inbox; domain_id or domain for verify_domain, get_domain_info, get_zone_file, check_domain_exists).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create_domain',
            'create_inbox',
            'delete_inbox',
            'verify_domain',
            'check_domain_exists',
            'get_domain_info',
            'get_zone_file',
          ],
          description: ACTION_DESCRIPTION,
        },
        domain: {
          type: 'string',
          description:
            'Domain name. Used by create_domain, create_inbox, check_domain_exists; also as domain_id for verify_domain, get_domain_info, get_zone_file.',
        },
        domain_id: {
          type: 'string',
          description:
            'Domain ID (usually the domain name). For verify_domain, get_domain_info, get_zone_file.',
        },
        feedback_enabled: {
          type: 'boolean',
          description: 'For create_domain: enable bounce/feedback tracking (default false).',
        },
        username: {
          type: 'string',
          description: 'For create_inbox: local part of the email (e.g. "hello" for hello@domain.com).',
        },
        display_name: {
          type: 'string',
          description: 'For create_inbox: optional display name for the inbox.',
        },
        client_id: {
          type: 'string',
          description: 'For create_inbox: optional client identifier.',
        },
        inbox_id: {
          type: 'string',
          description: 'For delete_inbox: AgentMail inbox ID to delete.',
        },
      },
      required: ['action'],
    },
    execute: async (args: ConfigureEmailToolParams) => {
      const result = await configureEmailCore({
        site_id,
        action: args.action,
        domain: args.domain,
        domain_id: args.domain_id,
        feedback_enabled: args.feedback_enabled,
        username: args.username,
        display_name: args.display_name,
        client_id: args.client_id,
        inbox_id: args.inbox_id,
      });
      if (!result.success && result.error) {
        throw new Error(result.error);
      }
      return result;
    },
  };
}
