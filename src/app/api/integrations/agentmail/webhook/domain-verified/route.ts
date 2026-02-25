import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';
import { supabaseAdmin } from '@/lib/database/supabase-server';

/**
 * POST handler for AgentMail domain.verified webhook event
 * Updates settings.channels.agent_email to status 'active' for the site that owns the domain
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] domain.verified webhook received');

    const body = await request.text();
    let payload = await verifySvixWebhook(body);

    if (!payload) {
      console.warn('⚠️ [AgentMail] Signature verification skipped, parsing body directly');
      try {
        payload = JSON.parse(body);
      } catch (parseError: any) {
        console.error('❌ [AgentMail] Failed to parse webhook body:', parseError.message);
        return NextResponse.json(
          { success: false, error: 'Invalid JSON payload' },
          { status: 400 }
        );
      }
    }

    if (!payload || payload.type !== 'event' || payload.event_type !== 'domain.verified') {
      return NextResponse.json(
        { success: false, error: 'Invalid payload structure' },
        { status: 400 }
      );
    }

    const domain = payload.domain || payload.data?.domain;
    const domainId = domain?.id ?? domain?.domain_id ?? null;
    const domainName =
      typeof domain === 'string'
        ? domain
        : (domain?.domain ?? domain?.name ?? null);

    if (domain) {
      console.log(`✅ [AgentMail] Domain verified: ${domainName || 'unknown'}`);
    } else {
      console.log(`✅ [AgentMail] Domain verified event received (no domain data in payload)`);
    }

    let settings: { site_id: string; channels: Record<string, unknown> } | null = null;
    let getError: { message: string } | null = null;

    if (domainId) {
      const result = await supabaseAdmin
        .from('settings')
        .select('site_id, channels')
        .filter('channels->agent_email->>domain_id', 'eq', String(domainId))
        .maybeSingle();
      settings = result.data as typeof settings | null;
      getError = result.error;
      if (getError) {
        console.error('[AgentMail] Error finding settings by domain_id:', getError);
      }
    }

    if ((!settings || !settings.site_id) && domainName) {
      console.log(`🔍 [AgentMail] Trying to find settings by domain name: ${domainName}`);
      const domainResult = await supabaseAdmin
        .from('settings')
        .select('site_id, channels')
        .filter('channels->agent_email->>domain', 'eq', domainName.toLowerCase().trim())
        .maybeSingle();
      if (domainResult.error) {
        console.error('[AgentMail] Error finding settings by domain:', domainResult.error);
      } else if (domainResult.data) {
        settings = domainResult.data as typeof settings;
        console.log(`✅ [AgentMail] Found settings by domain name for site_id: ${settings?.site_id}`);
      }
    }

    if (settings?.site_id && settings?.channels?.agent_email) {
      const currentChannels = settings.channels as Record<string, unknown>;
      const agentEmail = currentChannels.agent_email as Record<string, unknown>;
      const { dns_records, domain_status, error_message, ...rest } = agentEmail;
      const resolvedDomainId = domainId ?? (agentEmail.domain_id as string | undefined);
      const updatedAgentEmail = {
        ...rest,
        status: 'active',
        verified_at: new Date().toISOString(),
        ...(resolvedDomainId && { domain_id: resolvedDomainId }),
      };
      const updatedChannels = {
        ...currentChannels,
        agent_email: updatedAgentEmail,
      };

      const { error: updateError } = await supabaseAdmin
        .from('settings')
        .update({ channels: updatedChannels })
        .eq('site_id', settings.site_id);

      if (updateError) {
        console.error('[AgentMail] Error updating channel after domain verification:', updateError);
      } else {
        console.log(`[AgentMail] Channel updated to active for site_id: ${settings.site_id}`);
      }
    } else if (!settings?.site_id && (domainId || domainName)) {
      console.warn(
        `[AgentMail] No settings found for domain_id: ${domainId ?? 'n/a'} or domain: ${domainName ?? 'n/a'}`
      );
    }

    return NextResponse.json(
      { success: true, event_type: 'domain.verified', domain: domain || null },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('❌ [AgentMail] Error processing domain.verified webhook:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}

