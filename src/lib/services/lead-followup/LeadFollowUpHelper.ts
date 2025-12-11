import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { safeStringify } from '@/lib/helpers/lead-context-helper';

// Initialize agent and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();

// Helper to safely stringify JSON without crashing on circular references or large objects
export function safeJsonStringify(obj: any, maxLength: number = 500): string {
  try {
    const str = JSON.stringify(obj, null, 2);
    return str.length > maxLength ? str.substring(0, maxLength) + '... [truncated]' : str;
  } catch (error: any) {
    return `[JSON serialization error: ${error.message}]`;
  }
}

// Helper to parse both JSON and multipart/form-data requests
export async function parseIncomingRequest(request: Request, requestId?: string): Promise<{ body: any, files: Record<string, any> }> {
  const contentType = request.headers.get('content-type') || '';
  const files: Record<string, any> = {};
  let body: any = {};
  try {
    console.log(`[LeadFollowUp:${requestId || 'no-trace'}] CP0 content-type: ${contentType}`);
    if (contentType.includes('application/json')) {
      body = await request.json();
    } else if (contentType.includes('multipart/form-data')) {
      const formData = await (request as any).formData();
      for (const [key, value] of (formData as any).entries()) {
        if (typeof File !== 'undefined' && value instanceof File) {
          files[key] = value as any;
        } else {
          body[key] = value;
        }
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await (request as any).formData();
      for (const [key, value] of (formData as any).entries()) {
        body[key] = value;
      }
    } else {
      // Try JSON as a fallback
      try {
        body = await request.json();
      } catch {
        // No-op, leave body as empty
      }
    }
    console.log(`[LeadFollowUp:${requestId || 'no-trace'}] CP1 parsed keys:`, Object.keys(body));
    console.log(`[LeadFollowUp:${requestId || 'no-trace'}] CP1 files present:`, Object.keys(files));
  } catch (e) {
    console.error('Error parsing incoming request body:', e);
  }
  return { body, files };
}

// Function to validate UUIDs
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Function to validate phone numbers
export function isValidPhoneNumber(phoneNumber: string): boolean {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return false;
  }
  
  // Remove all whitespace and check if empty
  const cleanPhone = phoneNumber.trim();
  if (cleanPhone === '') {
    return false;
  }
  
  // Basic validation: must contain at least some digits and be at least 7 characters
  // This catches empty strings, whitespace-only strings, and very short inputs
  const digitCount = (cleanPhone.match(/\d/g) || []).length;
  const hasMinLength = cleanPhone.length >= 7;
  const hasMinDigits = digitCount >= 7;
  
  return hasMinLength && hasMinDigits;
}

// Function to get database UUID for a command
export async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    // Try to get the command
    const command = await commandService.getCommandById(internalId);
    
    // Check metadata
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID found in metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    // Search in CommandService internal translation map
    try {
      // @ts-ignore - Accessing internal properties
      const idMap = (commandService as any).idTranslationMap;
      if (idMap && idMap.get && idMap.get(internalId)) {
        const mappedId = idMap.get(internalId);
        if (isValidUUID(mappedId)) {
          console.log(`🔑 UUID found in internal map: ${mappedId}`);
          return mappedId;
        }
      }
    } catch (err) {
      console.log('Could not access internal translation map');
    }
    
    // Search in database directly by some field that might relate
    if (command) {
      const { data, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('task', command.task)
        .eq('user_id', command.user_id)
        .eq('status', command.status)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`🔑 UUID found in direct search: ${data[0].id}`);
        return data[0].id;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting database UUID:', error);
    return null;
  }
}

// Generic function to find an active agent by role
export async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Searching for active agent with role "${role}" for site: ${siteId}`);
    
    // Only search by site_id, role and status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error searching for agent with role "${role}":`, error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No active agent found with role "${role}" for site: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agent with role "${role}" found: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error searching for agent with role "${role}":`, error);
    return null;
  }
}

// Function to find an active sales agent for a site
export async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

// Function to find an active copywriter for a site
export async function findActiveCopywriter(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Content Creator & Copywriter');
}

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

// Function to wait for command completion
export async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Waiting for command ${commandId} to complete...`);
  
  // Create a promise that resolves when the command completes or times out
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ Could not find command ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
          return;
        }
        
        // Save database UUID if available
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 Database UUID found in metadata: ${dbUuid}`);
        }
        
        // Accept commands with status 'completed' OR 'failed' if they have valid results
        // This matches customerSupport behavior: process results even if status is 'failed'
        const hasValidResults = executedCommand.results && Array.isArray(executedCommand.results) && executedCommand.results.length > 0;
        const shouldAccept = executedCommand.status === 'completed' || 
                           (executedCommand.status === 'failed' && hasValidResults);
        
        if (shouldAccept) {
          console.log(`✅ Command ${commandId} completed with status: ${executedCommand.status}`);
          
          // Try to get database UUID if we still don't have it
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtained after completion: ${dbUuid || 'Not found'}`);
          }
          
          clearInterval(checkInterval);
          
          // Consider a command "completed" if:
          // 1. Status is 'completed', OR
          // 2. Status is 'failed' but has valid results (error was handled gracefully)
          const isEffectivelyCompleted = executedCommand.status === 'completed' || 
                                       (executedCommand.status === 'failed' && hasValidResults);
          
          console.log(`📊 Command ${commandId} analysis: status=${executedCommand.status}, hasResults=${hasValidResults}, effectivelyCompleted=${isEffectivelyCompleted}`);
          
          resolve({command: executedCommand, dbUuid, completed: isEffectivelyCompleted});
          return;
        }
        
        console.log(`⏳ Command ${commandId} still running (status: ${executedCommand.status}), attempt ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Timeout reached for command ${commandId}`);
          
          // Last attempt to get UUID
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtained before timeout: ${dbUuid || 'Not found'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
        }
      } catch (error) {
        console.error(`Error checking status of command ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Function to execute copywriter refinement
export async function executeCopywriterRefinement(
  siteId: string,
  agentId: string,
  userId: string,
  baseContext: string,
  salesFollowUpContent: any,
  leadId: string
): Promise<{ commandId: string; dbUuid: string | null; command: any } | null> {
  try {
    // Prepare context for second phase including first phase results
    let copywriterContext = baseContext;
    
    // Add first phase results to context
    if (salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      copywriterContext += `\n\n--- SALES TEAM INPUT (Phase 1 Results) ---\n`;
      copywriterContext += `The Sales/CRM Specialist has provided the following initial follow-up content that you need to refine:\n\n`;
      
      copywriterContext += `SELECTED CONTENT:\n`;
      copywriterContext += `├─ Channel: ${salesFollowUpContent.channel || 'Not specified'}\n`;
      copywriterContext += `├─ Title: ${salesFollowUpContent.title || 'Not specified'}\n`;
      copywriterContext += `├─ Strategy: ${salesFollowUpContent.strategy || 'Not specified'}\n`;
      copywriterContext += `├─ Message Language: ${salesFollowUpContent.message_language || 'Not specified'}\n`;
      copywriterContext += `└─ Message: ${salesFollowUpContent.message || 'Not specified'}\n\n`;
      
      copywriterContext += `--- COPYWRITER INSTRUCTIONS ---\n`;
      copywriterContext += `Your task is to IMPROVE and ENHANCE the sales content above, not to replace it completely.\n`;
      copywriterContext += `The sales team has already done excellent strategic work selecting the right channel and approach.\n`;
      copywriterContext += `IMPORTANT: The sales team has already selected the most effective channel (${salesFollowUpContent.channel}) to avoid overwhelming the lead.\n`;
      copywriterContext += `Your role is to POLISH and REFINE what they've created. For the selected content, you must:\n`;
      copywriterContext += `1. PRESERVE the original CHANNEL (${salesFollowUpContent.channel}) and overall strategy\n`;
      copywriterContext += `2. MAINTAIN the core sales message and intent - don't change the fundamental approach\n`;
      copywriterContext += `3. ENHANCE the TITLE to make it more engaging while keeping the same purpose\n`;
      copywriterContext += `4. IMPROVE the MESSAGE with better copywriting flow, clarity, and persuasion techniques\n`;
      copywriterContext += `5. OPTIMIZE language for better emotional connection while preserving sales objectives\n`;
      copywriterContext += `6. STRENGTHEN calls-to-action without changing the intended next step\n`;
      copywriterContext += `7. DO NOT use placeholders or variables like [Name], {Company}, {{Variable}}, etc.\n`;
      copywriterContext += `8. Use ONLY the real information provided in the lead context\n`;
      copywriterContext += `9. Write final content ready to send without additional editing\n`;
      copywriterContext += `10. SIGNATURE RULES: ALL CHANNELS already include automatic signatures/identifications, so DO NOT add any signature or sign-off. NEVER sign as the agent or AI - emails are sent from real company employees\n`;
      copywriterContext += `11. INTRODUCTION RULES: When introducing yourself or the company, always speak about the COMPANY, its RESULTS, ACHIEVEMENTS, or SERVICES - never about yourself as a person\n`;
      copywriterContext += `12. Focus on company value proposition, case studies, testimonials, or business outcomes rather than personal introductions\n`;
      copywriterContext += `13. 🎯 COPYWRITING APPROVAL PRIORITY: If there are approved copywritings available for this lead/campaign, respect them as much as possible. Only personalize with lead-specific information (name, company, pain points) to increase conversion. Maintain approved tone, structure, and core messaging.\n`;
      copywriterContext += `14. 🔑 KEY PRINCIPLE: Think of yourself as a writing coach helping the sales team express their ideas more effectively, not as someone replacing their work.\n`;
      copywriterContext += `15. ⚠️ OUTPUT FORMAT: Return 'refined_title' and 'refined_message' as separate fields as requested. Do not wrap them in a 'content' object.\n\n`;
    }
    
    // Create command for copywriter based on available channels from phase 1
    // Build refinement target based on phase 1 content
    let refinementTarget: {title: string, message: string, channel: string} | null = null;
    
    if (salesFollowUpContent && typeof salesFollowUpContent === 'object' && salesFollowUpContent.channel) {
      const channel = salesFollowUpContent.channel;
      const messageLanguage = salesFollowUpContent.message_language || 'inferred from lead name, region, or company location';
      
      switch (channel) {
        case 'email':
          refinementTarget = {
            title: `Refined and compelling email subject line that increases open rates (in ${messageLanguage})`,
            message: `Enhanced email message with persuasive copy, clear value proposition, and strong call-to-action (in ${messageLanguage})`,
            channel: channel
          };
          break;
        case 'whatsapp':
          refinementTarget = {
            title: `Improved WhatsApp message with casual yet professional tone (in ${messageLanguage})`,
            message: `Refined WhatsApp content that feels personal, direct, and encourages immediate response (in ${messageLanguage})`,
            channel: channel
          };
          break;
        case 'notification':
          refinementTarget = {
            title: `Enhanced in-app notification that captures attention (in ${messageLanguage})`,
            message: `Optimized notification message that's concise, actionable, and drives user engagement (in ${messageLanguage})`,
            channel: channel
          };
          break;
        case 'web':
          refinementTarget = {
            title: `Polished web popup/banner headline that converts (in ${messageLanguage})`,
            message: `Compelling web message with persuasive copy that motivates visitors to take action (in ${messageLanguage})`,
            channel: channel
          };
          break;
        default:
          refinementTarget = {
            title: `Refined ${channel} headline with improved copy (in ${messageLanguage})`,
            message: `Enhanced ${channel} message content with better persuasion and engagement (in ${messageLanguage})`,
            channel: channel
          };
      }
    }
    
    if (!refinementTarget) {
      console.error(`❌ PHASE 2: Cannot create copywriter command - refinementTarget is null (missing channel in sales content?)`);
      return null;
    }
    
    const copywriterCommand = CommandFactory.createCommand({
      task: 'lead nurture copywriting',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Polish and improve the follow-up content created by the sales team without changing the core strategy. Act as a writing coach to enhance clarity, flow, and persuasion while preserving the sales team approach, channel selection, and fundamental messaging. Focus on making the existing content more engaging and effective. Generate the refined title and message as separate fields.',
      targets: [
        {
          deep_thinking: "Analyze the sales team's strategically selected follow-up content and identify specific areas for copywriting improvement. Focus on enhancing clarity, flow, and persuasion while respecting and preserving the core sales strategy, channel selection, and messaging approach."
        },
        {
          refined_title: refinementTarget.title,
          refined_message: refinementTarget.message,
          channel: `Confirm the channel for this message (must be '${refinementTarget.channel}')`
        }
      ],
      context: copywriterContext,
      model: 'openai:gpt-5.1',
      supervisor: [
        {
          agent_role: 'creative_director',
          status: 'not_initialized'
        },
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        }
      ]
    });
    
    // Submit copywriter command
    const copywriterCommandId = await commandService.submitCommand(copywriterCommand);
    
    // Wait for copywriter command to complete
    const result = await waitForCommandCompletion(copywriterCommandId);
    
    if (result && result.completed && result.command) {
      // Extract refined content from results
      let refinedContent = [];
      if (result.command.results && Array.isArray(result.command.results)) {
        for (const commandResult of result.command.results) {
          if (commandResult.refined_content && Array.isArray(commandResult.refined_content)) {
            refinedContent = commandResult.refined_content;
            break;
          }
        }
      }
      
      return {
        commandId: copywriterCommandId,
        dbUuid: result.dbUuid,
        command: result.command
      };
    } else {
      console.error(`❌ PHASE 2: Copywriter command did not complete correctly`);
      return null;
    }
  } catch (error: any) {
    console.error(`❌ PHASE 2: Error creating/executing copywriter command:`, error.message);
    return null;
  }
}

export async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[]; activities?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`Invalid agent ID: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Getting agent information: ${agentId}`);
    
    // Query agent in database - Specify only the columns we need
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, site_id, configuration')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error getting agent information:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ Agent not found with ID: ${agentId}`);
      return null;
    }
    
    // Parse configuration if it's a string
    let config = data.configuration;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        console.error('Error parsing agent configuration:', e);
        config = {};
      }
    }
    
    // Ensure config is an object
    config = config || {};
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools: config.tools || [],
      activities: config.activities || []
    };
  } catch (error) {
    console.error('Error getting agent information:', error);
    return null;
  }
}
