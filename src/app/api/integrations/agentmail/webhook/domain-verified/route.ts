import { NextRequest, NextResponse } from 'next/server';
import { verifySvixWebhook } from '@/lib/integrations/agentmail/svix-verification';

/**
 * POST handler for AgentMail domain.verified webhook event
 * Logs domain verification events
 */
export async function POST(request: NextRequest) {
  try {
    console.log('📩 [AgentMail] domain.verified webhook received');

    // Get raw body for signature verification
    const body = await request.text();

    // Verify Svix signature (optional - falls back to parsing JSON if verification fails)
    let payload = await verifySvixWebhook(body);
    
    // If verification failed or secret not configured, parse body directly
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

    // Validate payload structure
    if (!payload || payload.type !== 'event' || payload.event_type !== 'domain.verified') {
      return NextResponse.json(
        { success: false, error: 'Invalid payload structure' },
        { status: 400 }
      );
    }

    // Log domain verification event
    const domain = payload.domain || payload.data?.domain;
    if (domain) {
      console.log(`✅ [AgentMail] Domain verified: ${domain.domain || domain.name || 'unknown'}`);
    } else {
      console.log(`✅ [AgentMail] Domain verified event received (no domain data in payload)`);
    }

    // TODO: If domain configuration is stored in database, update it here
    // Example:
    // await updateDomainVerificationStatus(domain.id, { verified: true, verified_at: new Date() });

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

