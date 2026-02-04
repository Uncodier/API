import { supabaseAdmin } from '@/lib/database/supabase-client';

// Function to get site channel configuration
export async function getSiteChannelsConfiguration(siteId: string): Promise<{
  hasChannels: boolean,
  configuredChannels: string[],
  channelsDetails: Record<string, any>,
  warning?: string
}> {
  try {
    console.log(`📡 Getting channel configuration for site: ${siteId}`);
    
    // Try with .single() first (like other parts of the codebase)
    // If that fails with PGRST116, it means no record exists
    let { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    // If we get PGRST116, try with alternative query as fallback
    if (error && error.code === 'PGRST116') {
      console.log(`⚠️ No record found with .single(), trying alternative query...`);
      
      // Try a broader query to see if record exists at all
      const { data: allSettings, error: allError } = await supabaseAdmin
        .from('settings')
        .select('id, site_id, channels')
        .eq('site_id', siteId)
        .limit(5);
      
      console.log(`📊 Alternative query result:`, {
        foundRecords: allSettings?.length || 0,
        hasError: !!allError,
        errorCode: allError?.code,
        errorMessage: allError?.message,
        records: allSettings?.map((s: any) => ({
          id: s.id,
          site_id: s.site_id,
          hasChannels: !!s.channels
        }))
      });
      
      if (allSettings && allSettings.length > 0) {
        // Record exists, use the first one
        const firstRecord = allSettings[0];
        if (firstRecord.channels) {
          data = { channels: firstRecord.channels };
          error = null;
        } else {
          return {
            hasChannels: false,
            configuredChannels: [],
            channelsDetails: {},
            warning: 'Settings record exists but channels field is null or missing'
          };
        }
      } else {
        // No record found at all - but let's also check if there's a typo in site_id
        console.log(`🔍 Checking if site_id might have a typo or format issue...`);
        console.log(`📋 Site ID being searched: "${siteId}" (length: ${siteId.length}, type: ${typeof siteId})`);
        
        return {
          hasChannels: false,
          configuredChannels: [],
          channelsDetails: {},
          warning: 'Settings record not found for this site'
        };
      }
    }
    
    if (error) {
      console.error(`❌ Error fetching settings:`, error);
      const errorMessage = error && typeof error === 'object' && 'message' in error 
        ? (error as any).message 
        : 'Unknown error';
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: `Error retrieving settings: ${errorMessage}`
      };
    }
    
    // Check if settings record exists
    if (!data) {
      const warning = `⚠️ Site ${siteId} has NO settings record in database. Cannot process message without settings.`;
      console.warn(warning);
      console.log(`📊 Settings record check:`, {
        siteId,
        recordExists: false
      });
      
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: 'Settings record not found for this site'
      };
    }
    
    // Check if channels field exists
    if (!data.channels) {
      const warning = `⚠️ Site ${siteId} has settings record but NO channels field. Cannot process message without channels.`;
      console.warn(warning);
      console.log(`📊 Settings data structure:`, {
        hasData: !!data,
        dataKeys: data ? Object.keys(data) : [],
        channelsType: data?.channels ? typeof data.channels : 'undefined',
        channelsValue: data?.channels
      });
      
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: 'Settings record exists but channels field is missing'
      };
    }
    
    // Parse channels if it's a string (JSON)
    let channels = data.channels;
    if (typeof channels === 'string') {
      try {
        channels = JSON.parse(channels);
        console.log(`📦 Parsed channels from JSON string`);
      } catch (parseError) {
        console.error(`❌ Error parsing channels JSON:`, parseError);
        return {
          hasChannels: false,
          configuredChannels: [],
          channelsDetails: {},
          warning: 'Invalid channels JSON format'
        };
      }
    }
    
    // Validate that parsed channels is a valid object (not null, not array, not primitive)
    if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) {
      const warning = `⚠️ Site ${siteId} has invalid channels configuration (null or invalid type). Cannot process message without valid channels.`;
      console.warn(warning);
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: 'Invalid channels configuration: channels is null or not an object'
      };
    }
    
    console.log(`📊 Channels structure:`, {
      type: typeof channels,
      isObject: typeof channels === 'object' && !Array.isArray(channels),
      keys: typeof channels === 'object' && !Array.isArray(channels) ? Object.keys(channels) : [],
      hasEmail: !!(channels?.email),
      hasWhatsapp: !!(channels?.whatsapp),
      hasAgentEmail: !!(channels?.agent_email),
      hasAgentWhatsapp: !!(channels?.agent_whatsapp),
      emailStatus: channels?.email?.status,
      agentEmailStatus: channels?.agent_email?.status,
      whatsappStatus: channels?.whatsapp?.status
    });
    const configuredChannels: string[] = [];
    const channelsDetails: Record<string, any> = {};
    
    // Check each available channel type
    
    // 1. Email (Standard)
    const emailConfig = channels.email;
    console.log(`📧 Checking standard email config:`, {
      exists: !!emailConfig,
      enabled: emailConfig?.enabled,
      status: emailConfig?.status,
      hasEmail: !!emailConfig?.email,
      hasAliases: !!emailConfig?.aliases
    });
    
    const isEmailEnabled = emailConfig && (emailConfig.enabled !== false) && (emailConfig.status !== 'not_configured');
    
    if (emailConfig && (emailConfig.email || emailConfig.aliases) && isEmailEnabled) {
      configuredChannels.push('email');
      channelsDetails.email = {
        type: 'email',
        email: emailConfig.email || null,
        aliases: emailConfig.aliases || [],
        description: 'Email marketing and outreach'
      };
      console.log(`✅ Standard email channel configured`);
    } else {
      console.log(`❌ Standard email NOT configured:`, {
        hasConfig: !!emailConfig,
        hasEmailOrAliases: !!(emailConfig?.email || emailConfig?.aliases),
        isEnabled: isEmailEnabled
      });
    }
    
    // 2. Agent Email (New)
    const agentEmailConfig = channels.agent_email;
    console.log(`📧 Checking agent_email config:`, {
      exists: !!agentEmailConfig,
      status: agentEmailConfig?.status,
      username: agentEmailConfig?.username,
      domain: agentEmailConfig?.domain,
      hasData: !!agentEmailConfig?.data,
      dataUsername: agentEmailConfig?.data?.username,
      dataDomain: agentEmailConfig?.data?.domain
    });
    
    const isAgentEmailActive = agentEmailConfig && String(agentEmailConfig.status) === 'active';
    console.log(`📧 Agent email active check:`, {
      hasConfig: !!agentEmailConfig,
      status: agentEmailConfig?.status,
      statusString: agentEmailConfig?.status ? String(agentEmailConfig.status) : 'undefined',
      isActive: isAgentEmailActive
    });
    
    // 🔧 ENHANCEMENT: If standard email is configured, log that agent_email is available as backup
    // Only require agent_email to be active if standard email is missing
    if (agentEmailConfig) {
      if (configuredChannels.includes('email')) {
        // Standard email already configured, agent_email is available as backup
        console.log(`ℹ️ Agent email available as backup (standard email already configured):`, {
          status: agentEmailConfig.status,
          isActive: isAgentEmailActive,
          note: 'Agent email can be used as fallback if standard email fails'
        });
      } else if (isAgentEmailActive) {
        // Standard email not configured, use agent_email
        configuredChannels.push('email');
        
        // Try to get email from different possible locations
        // Priority: 1) direct email field, 2) username@domain from top level, 3) username@domain from data object
        const username = agentEmailConfig.username || agentEmailConfig.data?.username;
        const domain = agentEmailConfig.domain || agentEmailConfig.data?.domain;
        const agentEmailAddress = agentEmailConfig.email || 
          (username && domain ? `${username}@${domain}` : null);
        
        console.log(`✅ Agent email channel configured (standard email missing):`, {
          email: agentEmailAddress,
          username,
          domain,
          source: agentEmailConfig.email ? 'direct' : 'constructed'
        });
        
        channelsDetails.email = {
          type: 'email',
          email: agentEmailAddress,
          aliases: [],
          description: 'Agent Email'
        };
      } else {
        console.log(`❌ Agent email NOT active and standard email not configured:`, {
          hasConfig: !!agentEmailConfig,
          status: agentEmailConfig?.status,
          isActive: isAgentEmailActive,
          note: 'No email channel available'
        });
      }
    }
    
    // 3. WhatsApp (Standard)
    console.log(`📱 Checking standard whatsapp config:`, {
      exists: !!channels.whatsapp,
      enabled: channels.whatsapp?.enabled,
      status: channels.whatsapp?.status,
      existingNumber: channels.whatsapp?.existingNumber
    });
    
    if (channels.whatsapp) {
      const whatsappNumber = channels.whatsapp.phone_number || channels.whatsapp.existingNumber || channels.whatsapp.number || channels.whatsapp.phone;
      const whatsappEnabled = channels.whatsapp.enabled !== false; // default to true if not explicitly false
      const whatsappStatusOk = !channels.whatsapp.status || String(channels.whatsapp.status).toLowerCase() === 'active';
      
      console.log(`📱 WhatsApp validation:`, {
        hasNumber: !!whatsappNumber,
        number: whatsappNumber,
        enabled: whatsappEnabled,
        statusOk: whatsappStatusOk
      });
      
      if (whatsappNumber && whatsappEnabled && whatsappStatusOk) {
        configuredChannels.push('whatsapp');
        channelsDetails.whatsapp = {
          type: 'whatsapp',
          phone_number: whatsappNumber,
          description: 'WhatsApp Business messaging'
        };
        console.log(`✅ Standard WhatsApp channel configured`);
      } else {
        console.log(`❌ Standard WhatsApp NOT configured:`, {
          hasNumber: !!whatsappNumber,
          enabled: whatsappEnabled,
          statusOk: whatsappStatusOk
        });
      }
    }
    
    // 4. Check agent_whatsapp
    const agentWhatsappConfig = channels.agent_whatsapp;
    console.log(`📱 Checking agent_whatsapp config:`, {
      exists: !!agentWhatsappConfig,
      status: agentWhatsappConfig?.status
    });
    
    if (agentWhatsappConfig && String(agentWhatsappConfig.status) === 'active') {
       if (!configuredChannels.includes('whatsapp')) {
         configuredChannels.push('whatsapp');
         const waNumber = agentWhatsappConfig.phone_number || agentWhatsappConfig.existingNumber || agentWhatsappConfig.number || agentWhatsappConfig.phone;
         channelsDetails.whatsapp = {
             type: 'whatsapp',
             phone_number: waNumber,
             description: 'Agent WhatsApp'
         };
         console.log(`✅ Agent WhatsApp channel configured`);
       } else {
         console.log(`ℹ️ Agent WhatsApp available but standard WhatsApp already configured`);
       }
    } else {
      console.log(`❌ Agent WhatsApp NOT active:`, {
        hasConfig: !!agentWhatsappConfig,
        status: agentWhatsappConfig?.status
      });
    }
    
    console.log(`📊 Final channel configuration:`, {
      configuredChannels,
      channelsCount: configuredChannels.length,
      hasChannels: configuredChannels.length > 0
    });
    
    return {
      hasChannels: configuredChannels.length > 0,
      configuredChannels,
      channelsDetails
    };
    
  } catch (error) {
    console.error('Error getting site channel configuration:', error);
    return {
      hasChannels: false,
      configuredChannels: [],
      channelsDetails: {},
      warning: 'Error retrieving channel configuration'
    };
  }
}

// Function to trigger channels setup required notification
export async function triggerChannelsSetupNotification(siteId: string): Promise<void> {
  try {
    console.log(`📧 CHANNELS SETUP: Triggering notification for site: ${siteId}`);
    
    // Make internal API call to channels setup notification endpoint
    const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/notifications/channelsSetupRequired`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        site_id: siteId
      })
    });
    
    if (response.ok) {
      try {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const result = await response.json();
          console.log(`✅ CHANNELS SETUP: Notification triggered successfully for site: ${siteId}`);
          console.log(`📊 CHANNELS SETUP: Result:`, result);
        } else {
          const text = await response.text();
          console.log(`✅ CHANNELS SETUP: Notification triggered successfully for site: ${siteId} (non-JSON response)`);
          console.log(`📊 CHANNELS SETUP: Response (first 200 chars):`, text.substring(0, 200));
        }
      } catch (parseError) {
        console.log(`✅ CHANNELS SETUP: Notification triggered for site: ${siteId} (response parsing skipped)`);
      }
    } else {
      try {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const error = await response.json();
          console.error(`❌ CHANNELS SETUP: Failed to trigger notification for site: ${siteId}`, error);
        } else {
          const text = await response.text();
          console.error(`❌ CHANNELS SETUP: Failed to trigger notification for site: ${siteId} (non-JSON error)`);
          console.error(`❌ CHANNELS SETUP: Error response (first 500 chars):`, text.substring(0, 500));
        }
      } catch (parseError) {
        console.error(`❌ CHANNELS SETUP: Failed to trigger notification for site: ${siteId} (status: ${response.status})`);
        console.error(`❌ CHANNELS SETUP: Could not parse error response:`, parseError);
      }
    }
  } catch (error) {
    console.error(`❌ CHANNELS SETUP: Error triggering notification for site: ${siteId}:`, error);
  }
}

// Function to manually filter and correct channel based on site configuration
export function filterAndCorrectMessageChannel(
  messages: any,
  configuredChannels: string[],
  leadContact?: { hasEmail?: boolean; hasPhone?: boolean; leadEmail?: string | null; leadPhone?: string | null }
): { correctedMessages: any, corrections: string[] } {
  const corrections: string[] = [];
  const correctedMessages: any = {};
  
  // Process each message channel
  for (const [originalChannel, messageData] of Object.entries(messages)) {
    let targetChannel = originalChannel;
    let needsCorrection = false;
    const leadHasEmail = !!leadContact?.hasEmail && !!(leadContact?.leadEmail && String(leadContact.leadEmail).trim() !== '');
    const leadHasPhone = !!leadContact?.hasPhone && !!(leadContact?.leadPhone && String(leadContact.leadPhone).trim() !== '');
    
    // Manual filtering logic
    if (originalChannel === 'whatsapp') {
      // If WhatsApp not configured OR lead lacks phone, try fallback to email
      const whatsappConfigured = configuredChannels.includes('whatsapp');
      if (!whatsappConfigured || !leadHasPhone) {
        if (configuredChannels.includes('email') && leadHasEmail) {
          targetChannel = 'email';
          needsCorrection = true;
          const reason = !whatsappConfigured ? 'WhatsApp not configured' : 'Lead has no phone number';
          corrections.push(`Changed ${originalChannel} → ${targetChannel} (${reason})`);
        } else {
          continue; // Skip this message if no valid alternative
        }
      }
    } else if (originalChannel === 'email') {
      // If Email not configured OR lead lacks email, try fallback to WhatsApp
      const emailConfigured = configuredChannels.includes('email');
      if (!emailConfigured || !leadHasEmail) {
        if (configuredChannels.includes('whatsapp') && leadHasPhone) {
          targetChannel = 'whatsapp';
          needsCorrection = true;
          const reason = !emailConfigured ? 'Email not configured' : 'Lead has no email address';
          corrections.push(`Changed ${originalChannel} → ${targetChannel} (${reason})`);
        } else {
          continue; // Skip this message if no valid alternative
        }
      }
    } else if (!configuredChannels.includes(originalChannel)) {
      // Channel not supported or not configured, skip
      continue;
    }
    
    // Add message to corrected messages
    correctedMessages[targetChannel] = {
      ...(typeof messageData === 'object' && messageData !== null ? messageData : {}),
      channel: targetChannel
    };
    
    // Add correction metadata if needed
    if (needsCorrection) {
      correctedMessages[targetChannel].original_channel = originalChannel;
      // Provide a clearer correction reason already pushed into corrections[]
      const lastCorrection = corrections[corrections.length - 1] || '';
      const reason = lastCorrection.includes('(') ? lastCorrection.substring(lastCorrection.indexOf('(') + 1, lastCorrection.lastIndexOf(')')) : 'Channel correction applied';
      correctedMessages[targetChannel].correction_reason = reason;
    }
  }
  
  return {
    correctedMessages,
    corrections
  };
}
