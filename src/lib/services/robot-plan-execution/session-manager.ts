/**
 * Session Management Service
 * Handles authentication session detection, analysis, and creation
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Detect required sessions based on plan steps
 */
export function detectRequiredSessions(steps: any[], plan: any): Array<{
  platform: string;
  domain: string;
  needed_for: string;
  suggested_auth_type: string;
}> {
  const requiredSessions: Array<{
    platform: string;
    domain: string;
    needed_for: string;
    suggested_auth_type: string;
  }> = [];

  // Mapping of common platforms
  const platformMappings = {
    'facebook': { domain: 'facebook.com', auth_type: 'cookies' },
    'instagram': { domain: 'instagram.com', auth_type: 'cookies' },
    'linkedin': { domain: 'linkedin.com', auth_type: 'cookies' },
    'twitter': { domain: 'twitter.com', auth_type: 'cookies' },
    'google': { domain: 'google.com', auth_type: 'oauth' },
    'youtube': { domain: 'youtube.com', auth_type: 'oauth' },
    'tiktok': { domain: 'tiktok.com', auth_type: 'cookies' },
    'pinterest': { domain: 'pinterest.com', auth_type: 'cookies' },
    'reddit': { domain: 'reddit.com', auth_type: 'cookies' },
  };

  // Search in titles and descriptions of steps
  const allText = [
    plan.title || '',
    plan.description || '',
    ...steps.map(step => `${step.title || ''} ${step.description || ''}`)
  ].join(' ').toLowerCase();

  Object.entries(platformMappings).forEach(([platform, config]) => {
    if (allText.includes(platform)) {
      const existingReq = requiredSessions.find(req => req.platform === platform);
      if (!existingReq) {
        requiredSessions.push({
          platform,
          domain: config.domain,
          needed_for: `Platform interaction mentioned in plan steps`,
          suggested_auth_type: config.auth_type,
        });
      }
    }
  });

  // Detect specific domain mentions
  const domainPattern = /([a-zA-Z0-9-]+\.(?:com|org|net|io|co))/g;
  const mentions = allText.match(domainPattern) || [];
  
  mentions.forEach(domain => {
    const existingReq = requiredSessions.find(req => req.domain === domain);
    if (!existingReq) {
      requiredSessions.push({
        platform: domain.split('.')[0],
        domain,
        needed_for: `Domain mentioned in plan`,
        suggested_auth_type: 'cookies',
      });
    }
  });

  return requiredSessions;
}

/**
 * Analyze session availability
 */
export function analyzeSessionsAvailability(existingSessions: any[], requiredSessions: any[]): {
  available: any[];
  missing: any[];
  expired: any[];
} {
  const available: any[] = [];
  const missing: any[] = [];
  const expired: any[] = [];

  requiredSessions.forEach(required => {
    const matchingSession = existingSessions.find(session => 
      session.domain === required.domain ||
      session.domain.includes(required.platform) ||
      required.domain.includes(session.domain.split('.')[0])
    );

    if (matchingSession) {
      // Check if session is expired
      if (matchingSession.expires_at && new Date(matchingSession.expires_at) < new Date()) {
        expired.push({
          ...required,
          existing_session: matchingSession
        });
      } else if (!matchingSession.is_valid) {
        expired.push({
          ...required,
          existing_session: matchingSession
        });
      } else {
        available.push({
          ...required,
          existing_session: matchingSession
        });
      }
    } else {
      missing.push(required);
    }
  });

  return { available, missing, expired };
}

/**
 * Request session creation
 */
export async function requestSessionCreation(
  instance_id: string, 
  platform: string, 
  domain: string, 
  agentMessage: string, 
  plan: any
) {
  try {
    // Create session request log
    await supabaseAdmin.from('instance_logs').insert({
      log_type: 'session_request',
      level: 'info',
      message: `Agent requested session creation for ${platform} on ${domain}`,
      details: {
        platform,
        domain,
        agent_message: agentMessage,
        plan_id: plan.id,
        plan_title: plan.title,
        suggested_auth_type: platform === 'google' || platform === 'youtube' ? 'oauth' : 'cookies',
      },
      instance_id: instance_id,
      site_id: plan.site_id,
      user_id: plan.user_id,
      agent_id: plan.agent_id,
      command_id: plan.command_id,
    });

    // TODO: Here could implement automatic notification to user
    // or even try to start session automatically if possible
    
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Session creation requested and logged for ${platform} on ${domain}`);
  } catch (error) {
    console.error('Error requesting session creation:', error);
  }
}

/**
 * Save session state
 */
export async function saveSessionState(instance_id: string, remoteInstance: any, plan: any) {
  try {
    // Get current session state from Scrapybara
    const sessionState = {
      instance_id: remoteInstance.id,
      status: 'saved',
      timestamp: new Date().toISOString(),
      plan_id: plan.id,
      plan_title: plan.title,
    };

    // Save to database
    await supabaseAdmin.from('instance_sessions').insert({
      instance_id: instance_id,
      remote_instance_id: remoteInstance.id,
      session_data: sessionState,
      saved_at: new Date().toISOString(),
      session_type: 'agent_saved',
      plan_id: plan.id,
    });

    // TODO: Implement saving to Scrapybara if they have API for that
    // await remoteInstance.saveSession();

    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Session state saved for instance: ${instance_id}`);
  } catch (error) {
    console.error('Error saving session state:', error);
  }
}

/**
 * Format sessions as context string for agent
 */
export function formatSessionsContext(existingSessions: any[]): string {
  if (existingSessions && existingSessions.length > 0) {
    return `\n🔐 AVAILABLE AUTHENTICATION SESSIONS (${existingSessions.length} total):\n` +
      existingSessions.map((session, index) => 
        `${index + 1}. **${session.name}** (${session.domain})\n` +
        `   Type: ${session.auth_type}\n` +
        `   Last used: ${session.last_used_at ? new Date(session.last_used_at).toLocaleString() : 'Never'}\n` +
        `   Usage count: ${session.usage_count || 0}\n` +
        `   Provider ID: ${session.provider_auth_state_id || 'Not set'}\n`
      ).join('\n') + '\n';
  } else {
    return '\n⚠️ NO AUTHENTICATION SESSIONS AVAILABLE\n' +
      'You may need to create authentication sessions for platforms before executing certain tasks.\n\n';
  }
}

/**
 * Format session requirements context
 */
export function formatSessionRequirementsContext(sessionsAnalysis: {
  available: any[];
  missing: any[];
  expired: any[];
}): string {
  if (sessionsAnalysis.missing.length > 0) {
    return `\n🚨 REQUIRED SESSIONS MISSING:\n` +
      sessionsAnalysis.missing.map(req => 
        `• ${req.platform} (${req.domain}) - needed for: ${req.needed_for}\n` +
        `  Suggested auth type: ${req.suggested_auth_type}\n`
      ).join('') + '\n';
  } else {
    return `\n✅ ALL REQUIRED SESSIONS AVAILABLE\n\n`;
  }
}
