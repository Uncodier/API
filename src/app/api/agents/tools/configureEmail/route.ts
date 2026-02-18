import { NextRequest, NextResponse } from 'next/server';
import {
  createDomain,
  createInbox,
  deleteInbox,
  verifyDomain,
  checkDomainExists,
  getDomainInfo,
  getZoneFile,
} from '@/lib/integrations/agentmail/agentmail-service';

export type ConfigureEmailAction =
  | 'create_domain'
  | 'create_inbox'
  | 'delete_inbox'
  | 'verify_domain'
  | 'check_domain_exists'
  | 'get_domain_info'
  | 'get_zone_file';

export interface ConfigureEmailBody {
  site_id: string;
  action: ConfigureEmailAction;
  /** For create_domain: domain name and feedback_enabled */
  domain?: string;
  feedback_enabled?: boolean;
  /** For create_inbox: username, domain, display_name, client_id */
  username?: string;
  display_name?: string;
  client_id?: string;
  /** For delete_inbox, get_domain_info, get_zone_file, verify_domain */
  inbox_id?: string;
  domain_id?: string;
}

export interface ConfigureEmailResult {
  success: boolean;
  action: ConfigureEmailAction;
  data?: unknown;
  error?: string;
}

/**
 * Core logic: run the requested AgentMail configuration action.
 * Callable directly (assistant) or via HTTP.
 */
export async function configureEmailCore(
  params: ConfigureEmailBody
): Promise<ConfigureEmailResult> {
  const { action } = params;

  if (!process.env.AGENTMAIL_API_KEY) {
    return {
      success: false,
      action,
      error: 'AGENTMAIL_API_KEY is not configured',
    };
  }

  try {
    switch (action) {
      case 'create_domain': {
        const domain = params.domain;
        const feedback_enabled = params.feedback_enabled ?? false;
        if (!domain) {
          return { success: false, action, error: 'domain is required for create_domain' };
        }
        const data = await createDomain({ domain, feedback_enabled });
        return { success: true, action, data };
      }

      case 'create_inbox': {
        const username = params.username;
        const domain = params.domain;
        if (!username || !domain) {
          return {
            success: false,
            action,
            error: 'username and domain are required for create_inbox',
          };
        }
        const data = await createInbox({
          username,
          domain,
          display_name: params.display_name,
          client_id: params.client_id,
        });
        return { success: true, action, data };
      }

      case 'delete_inbox': {
        const inbox_id = params.inbox_id;
        if (!inbox_id) {
          return { success: false, action, error: 'inbox_id is required for delete_inbox' };
        }
        await deleteInbox(inbox_id);
        return { success: true, action, data: { deleted: true, inbox_id } };
      }

      case 'verify_domain': {
        const domain_id = params.domain_id ?? params.domain;
        if (!domain_id) {
          return {
            success: false,
            action,
            error: 'domain_id or domain is required for verify_domain',
          };
        }
        const data = await verifyDomain(domain_id);
        return { success: true, action, data };
      }

      case 'check_domain_exists': {
        const domain = params.domain ?? params.domain_id;
        if (!domain) {
          return {
            success: false,
            action,
            error: 'domain is required for check_domain_exists',
          };
        }
        const exists = await checkDomainExists(domain);
        return { success: true, action, data: { domain, exists } };
      }

      case 'get_domain_info': {
        const domain_id = params.domain_id ?? params.domain;
        if (!domain_id) {
          return {
            success: false,
            action,
            error: 'domain_id or domain is required for get_domain_info',
          };
        }
        const data = await getDomainInfo(domain_id);
        return { success: true, action, data: data ?? { domain_id, not_found: true } };
      }

      case 'get_zone_file': {
        const domain_id = params.domain_id ?? params.domain;
        if (!domain_id) {
          return {
            success: false,
            action,
            error: 'domain_id or domain is required for get_zone_file',
          };
        }
        const zone_file = await getZoneFile(domain_id);
        return { success: true, action, data: { domain_id, zone_file } };
      }

      default: {
        const unknown = action as string;
        return {
          success: false,
          action: unknown as ConfigureEmailAction,
          error: `Unknown action: ${unknown}. Use one of: create_domain, create_inbox, delete_inbox, verify_domain, check_domain_exists, get_domain_info, get_zone_file`,
        };
      }
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`[configureEmail] ${action} error:`, err);
    return { success: false, action, error: message };
  }
}

/**
 * POST /api/agents/tools/configureEmail
 * Body: { site_id, action, ...params }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ConfigureEmailBody;
    const { site_id, action } = body;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'site_id is required' },
        { status: 400 }
      );
    }
    if (!action) {
      return NextResponse.json(
        { success: false, error: 'action is required' },
        { status: 400 }
      );
    }

    const result = await configureEmailCore(body);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[configureEmail] Request error:', error);
    return NextResponse.json(
      {
        success: false,
        action: undefined,
        error: error?.message ?? 'Internal server error',
      },
      { status: 500 }
    );
  }
}
