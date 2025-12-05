/**
 * AgentMail API Service
 * Handles communication with AgentMail API for sending messages
 */

const AGENTMAIL_BASE_URL = 'https://api.agentmail.to';

export interface SendMessageParams {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  labels?: string[];
  attachments?: Array<{
    filename: string;
    content: string; // Base64 encoded
    content_type?: string;
  }>;
  headers?: Record<string, string>;
}

export interface SendMessageResponse {
  message_id: string;
  thread_id: string;
}

export interface AgentMailError {
  error: string;
  message?: string;
  code?: string;
}

export interface CreateInboxParams {
  username?: string;
  domain?: string;
  display_name?: string;
  client_id?: string;
}

export interface CreateInboxResponse {
  pod_id: string;
  inbox_id: string;
  updated_at: string;
  created_at: string;
  display_name: string;
  client_id: string;
}

/**
 * Sends a message via AgentMail API
 * @param inbox_id AgentMail inbox ID
 * @param params Message parameters
 * @returns Response with message_id and thread_id
 * @throws Error if API call fails
 */
export async function sendMessage(
  inbox_id: string,
  params: SendMessageParams
): Promise<SendMessageResponse> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!inbox_id) {
    throw new Error('inbox_id is required');
  }

  // Prepare request payload
  const payload: any = {};

  if (params.to) {
    payload.to = Array.isArray(params.to) ? params.to : [params.to];
  }
  if (params.cc) {
    payload.cc = Array.isArray(params.cc) ? params.cc : [params.cc];
  }
  if (params.bcc) {
    payload.bcc = Array.isArray(params.bcc) ? params.bcc : [params.bcc];
  }
  if (params.reply_to) {
    payload.reply_to = Array.isArray(params.reply_to) ? params.reply_to : [params.reply_to];
  }
  if (params.subject) {
    payload.subject = params.subject;
  }
  if (params.text) {
    payload.text = params.text;
  }
  if (params.html) {
    payload.html = params.html;
  }
  if (params.labels && params.labels.length > 0) {
    payload.labels = params.labels;
  }
  if (params.attachments && params.attachments.length > 0) {
    payload.attachments = params.attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      content_type: att.content_type || 'application/octet-stream',
    }));
  }
  if (params.headers && Object.keys(params.headers).length > 0) {
    payload.headers = params.headers;
  }

  const url = `${AGENTMAIL_BASE_URL}/v0/inboxes/${inbox_id}/messages/send`;

  console.log(`[AgentMail] Sending message to inbox: ${inbox_id}`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[AgentMail] Failed to parse response:', responseText);
      throw new Error(`Invalid JSON response from AgentMail API: ${responseText}`);
    }

    if (!response.ok) {
      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Map AgentMail error codes to appropriate error messages
      if (response.status === 400) {
        throw new Error(`Validation Error: ${error.message || error.error}`);
      } else if (response.status === 403) {
        throw new Error(`Message Rejected: ${error.message || error.error}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found: ${error.message || error.error}`);
      } else {
        throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
      }
    }

    // Validate response structure
    if (!responseData.message_id || !responseData.thread_id) {
      throw new Error('Invalid response from AgentMail API: missing message_id or thread_id');
    }

    console.log(`[AgentMail] Message sent successfully:`, {
      message_id: responseData.message_id,
      thread_id: responseData.thread_id,
    });

    return {
      message_id: responseData.message_id,
      thread_id: responseData.thread_id,
    };
  } catch (error: any) {
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }
    console.error('[AgentMail] Error sending message:', error);
    throw new Error(`Failed to send message via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Creates a new inbox via AgentMail API
 * @param params Inbox creation parameters
 * @returns Response with inbox details
 * @throws Error if API call fails
 */
export async function createInbox(
  params: CreateInboxParams
): Promise<CreateInboxResponse> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  // Prepare request payload
  const payload: any = {};

  if (params.username) {
    payload.username = params.username;
  }
  if (params.domain) {
    payload.domain = params.domain;
  }
  if (params.display_name) {
    payload.display_name = params.display_name;
  }
  if (params.client_id) {
    payload.client_id = params.client_id;
  }

  const url = `${AGENTMAIL_BASE_URL}/v0/inboxes`;

  console.log(`[AgentMail] Creating new inbox`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[AgentMail] Failed to parse response:', responseText);
      throw new Error(`Invalid JSON response from AgentMail API: ${responseText}`);
    }

    if (!response.ok) {
      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Map AgentMail error codes to appropriate error messages
      if (response.status === 400) {
        throw new Error(`Validation Error: ${error.message || error.error}`);
      } else if (response.status === 403) {
        // Check if error is due to domain not being verified
        const errorMsg = error.message || error.error || '';
        if (errorMsg.toLowerCase().includes('not verified') || 
            (errorMsg.toLowerCase().includes('domain') && errorMsg.toLowerCase().includes('verified'))) {
          // Create a special error that can be caught and handled as a pending state
          const domainNotVerifiedError: any = new Error(`Domain Not Verified: ${errorMsg}`);
          domainNotVerifiedError.isDomainNotVerified = true;
          domainNotVerifiedError.statusCode = 403;
          throw domainNotVerifiedError;
        }
        throw new Error(`Forbidden: ${error.message || error.error}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found: ${error.message || error.error}`);
      } else {
        throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
      }
    }

    // Validate response structure
    if (!responseData.inbox_id) {
      throw new Error('Invalid response from AgentMail API: missing inbox_id');
    }

    console.log(`[AgentMail] Inbox created successfully:`, {
      inbox_id: responseData.inbox_id,
      pod_id: responseData.pod_id,
    });

    return {
      pod_id: responseData.pod_id,
      inbox_id: responseData.inbox_id,
      updated_at: responseData.updated_at,
      created_at: responseData.created_at,
      display_name: responseData.display_name,
      client_id: responseData.client_id,
    };
  } catch (error: any) {
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }
    console.error('[AgentMail] Error creating inbox:', error);
    throw new Error(`Failed to create inbox via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Deletes an inbox via AgentMail API
 * @param inbox_id AgentMail inbox ID
 * @throws Error if API call fails
 */
export async function deleteInbox(inbox_id: string): Promise<void> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!inbox_id) {
    throw new Error('inbox_id is required');
  }

  const url = `${AGENTMAIL_BASE_URL}/v0/inboxes/${inbox_id}`;

  console.log(`[AgentMail] Deleting inbox: ${inbox_id}`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch (parseError) {
        // If response is not JSON, use the text
        responseData = { error: responseText };
      }

      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Map AgentMail error codes to appropriate error messages
      if (response.status === 400) {
        throw new Error(`Validation Error: ${error.message || error.error}`);
      } else if (response.status === 403) {
        throw new Error(`Forbidden: ${error.message || error.error}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found: ${error.message || error.error}`);
      } else {
        throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
      }
    }

    console.log(`[AgentMail] Inbox deleted successfully: ${inbox_id}`);
  } catch (error: any) {
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }
    console.error('[AgentMail] Error deleting inbox:', error);
    throw new Error(`Failed to delete inbox via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

export interface CreateDomainParams {
  domain: string;
  feedback_enabled: boolean;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  status: string;
  priority: number;
}

export interface CreateDomainResponse {
  domain_id: string;
  status: 'PENDING' | 'VERIFYING' | 'READY';
  feedback_enabled: boolean;
  records: DnsRecord[];
  updated_at: string;
  created_at: string;
  pod_id: string | null;
  client_id: string | null;
}

/**
 * Creates a new domain via AgentMail API
 * @param params Domain creation parameters
 * @returns Response with domain details
 * @throws Error if API call fails
 */
export async function createDomain(
  params: CreateDomainParams
): Promise<CreateDomainResponse> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!params.domain) {
    throw new Error('domain is required');
  }

  if (typeof params.feedback_enabled !== 'boolean') {
    throw new Error('feedback_enabled is required and must be a boolean');
  }

  // Prepare request payload
  const payload = {
    domain: params.domain,
    feedback_enabled: params.feedback_enabled,
  };

  const url = `${AGENTMAIL_BASE_URL}/v0/domains`;

  console.log(`[AgentMail] Creating new domain: ${params.domain}`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[AgentMail] Failed to parse response:', responseText);
      throw new Error(`Invalid JSON response from AgentMail API: ${responseText}`);
    }

    if (!response.ok) {
      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Map AgentMail error codes to appropriate error messages
      if (response.status === 400) {
        throw new Error(`Validation Error: ${error.message || error.error}`);
      } else if (response.status === 403) {
        throw new Error(`Forbidden: ${error.message || error.error}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found: ${error.message || error.error}`);
      } else {
        throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
      }
    }

    // Validate response structure
    if (!responseData.domain_id) {
      throw new Error('Invalid response from AgentMail API: missing domain_id');
    }

    console.log(`[AgentMail] Domain created successfully:`, {
      domain_id: responseData.domain_id,
      status: responseData.status,
    });

    return {
      domain_id: responseData.domain_id,
      status: responseData.status,
      feedback_enabled: responseData.feedback_enabled,
      records: responseData.records || [],
      updated_at: responseData.updated_at,
      created_at: responseData.created_at,
      pod_id: responseData.pod_id || null,
      client_id: responseData.client_id || null,
    };
  } catch (error: any) {
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }
    console.error('[AgentMail] Error creating domain:', error);
    throw new Error(`Failed to create domain via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Checks if a domain exists in AgentMail
 * @param domain Domain name to check
 * @returns true if domain exists, false otherwise
 */
export async function checkDomainExists(domain: string): Promise<boolean> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!domain) {
    throw new Error('domain is required');
  }

  const url = `${AGENTMAIL_BASE_URL}/v0/domains/${encodeURIComponent(domain)}/zone-file`;

  console.log(`[AgentMail] Checking if domain exists: ${domain}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    // If 200, domain exists
    if (response.ok) {
      console.log(`[AgentMail] Domain exists: ${domain}`);
      return true;
    }

    // If 404, domain doesn't exist
    if (response.status === 404) {
      console.log(`[AgentMail] Domain does not exist: ${domain}`);
      return false;
    }

    // For other errors, try to parse and throw
    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      // If response is not JSON, use the text
      responseData = { error: responseText };
    }

    const error: AgentMailError = responseData;
    console.error('[AgentMail] API error checking domain:', {
      status: response.status,
      error: error.error,
      message: error.message,
      code: error.code,
    });

    // For other status codes, throw an error
    throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
  } catch (error: any) {
    // If error message includes "Not Found", domain doesn't exist
    if (error.message && error.message.includes('Not Found')) {
      console.log(`[AgentMail] Domain does not exist (from error): ${domain}`);
      return false;
    }

    // Re-throw other errors
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }

    console.error('[AgentMail] Error checking domain existence:', error);
    throw new Error(`Failed to check domain existence via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Gets the zone file for a domain via AgentMail API
 * @param domain_id Domain ID (domain name)
 * @returns Zone file content as string
 * @throws Error if API call fails
 */
export async function getZoneFile(domain_id: string): Promise<string> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!domain_id) {
    throw new Error('domain_id is required');
  }

  const url = `${AGENTMAIL_BASE_URL}/v0/domains/${encodeURIComponent(domain_id)}/zone-file`;

  console.log(`[AgentMail] Getting zone file for domain: ${domain_id}`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch (parseError) {
        // If response is not JSON, use the text
        responseData = { error: responseText };
      }

      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Map AgentMail error codes to appropriate error messages
      if (response.status === 400) {
        throw new Error(`Validation Error: ${error.message || error.error}`);
      } else if (response.status === 403) {
        throw new Error(`Forbidden: ${error.message || error.error}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found: ${error.message || error.error}`);
      } else {
        throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
      }
    }

    // Zone file is returned as text/plain
    const zoneFileContent = await response.text();

    console.log(`[AgentMail] Zone file retrieved successfully for domain: ${domain_id}`);

    return zoneFileContent;
  } catch (error: any) {
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }
    console.error('[AgentMail] Error getting zone file:', error);
    throw new Error(`Failed to get zone file via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Gets domain information including DNS records via AgentMail API
 * @param domain_id Domain ID (domain name)
 * @returns Domain information with DNS records
 * @throws Error if API call fails
 */
export async function getDomainInfo(domain_id: string): Promise<CreateDomainResponse | null> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!domain_id) {
    throw new Error('domain_id is required');
  }

  // Try to get domain info from the domains endpoint
  // Note: AgentMail API might not have a direct GET endpoint for domain info
  // In that case, we'll return null and the zone file can be used instead
  const url = `${AGENTMAIL_BASE_URL}/v0/domains/${encodeURIComponent(domain_id)}`;

  console.log(`[AgentMail] Getting domain info for: ${domain_id}`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      // If endpoint doesn't exist (404) or other error, return null
      // The zone file endpoint can be used as fallback
      if (response.status === 404) {
        console.log(`[AgentMail] Domain info endpoint not available, zone file can be used instead`);
        return null;
      }
      
      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch (parseError) {
        responseData = { error: responseText };
      }

      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error getting domain info:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Return null instead of throwing, so we can continue with zone file
      return null;
    }

    const responseData = await response.json();

    // Validate response structure
    if (!responseData.domain_id) {
      return null;
    }

    console.log(`[AgentMail] Domain info retrieved successfully for: ${domain_id}`);

    return {
      domain_id: responseData.domain_id,
      status: responseData.status || 'NOT_STARTED',
      feedback_enabled: responseData.feedback_enabled || false,
      records: responseData.records || [],
      updated_at: responseData.updated_at || new Date().toISOString(),
      created_at: responseData.created_at || new Date().toISOString(),
      pod_id: responseData.pod_id || null,
      client_id: responseData.client_id || null,
    };
  } catch (error: any) {
    // Return null instead of throwing, so we can continue
    console.log(`[AgentMail] Could not get domain info, zone file can be used instead: ${error.message}`);
    return null;
  }
}

export interface VerifyDomainResponse {
  domain_id: string;
  status: 'PENDING' | 'VERIFYING' | 'READY' | 'VERIFIED';
  feedback_enabled?: boolean;
  records?: DnsRecord[];
  updated_at: string;
  created_at?: string;
  pod_id?: string | null;
  client_id?: string | null;
}

/**
 * Verifies a domain via AgentMail API
 * @param domain_id Domain ID (domain name)
 * @returns Verification response with domain status
 * @throws Error if API call fails
 */
export async function verifyDomain(domain_id: string): Promise<VerifyDomainResponse> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!apiKey) {
    throw new Error('AGENTMAIL_API_KEY environment variable is not configured');
  }

  if (!domain_id) {
    throw new Error('domain_id is required');
  }

  const url = `${AGENTMAIL_BASE_URL}/v0/domains/${encodeURIComponent(domain_id)}/verify`;

  console.log(`[AgentMail] Verifying domain: ${domain_id}`);
  console.log(`[AgentMail] Request URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[AgentMail] Failed to parse response:', responseText);
      throw new Error(`Invalid JSON response from AgentMail API: ${responseText}`);
    }

    if (!response.ok) {
      const error: AgentMailError = responseData;
      console.error('[AgentMail] API error:', {
        status: response.status,
        error: error.error,
        message: error.message,
        code: error.code,
      });

      // Map AgentMail error codes to appropriate error messages
      if (response.status === 400) {
        throw new Error(`Validation Error: ${error.message || error.error}`);
      } else if (response.status === 403) {
        throw new Error(`Forbidden: ${error.message || error.error}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found: ${error.message || error.error}`);
      } else {
        throw new Error(`AgentMail API Error: ${error.message || error.error || 'Unknown error'}`);
      }
    }

    // Validate response structure
    if (!responseData.domain_id) {
      throw new Error('Invalid response from AgentMail API: missing domain_id');
    }

    console.log(`[AgentMail] Domain verified successfully:`, {
      domain_id: responseData.domain_id,
      status: responseData.status,
    });

    return {
      domain_id: responseData.domain_id,
      status: responseData.status || 'VERIFYING',
      feedback_enabled: responseData.feedback_enabled,
      records: responseData.records || [],
      updated_at: responseData.updated_at || new Date().toISOString(),
      created_at: responseData.created_at,
      pod_id: responseData.pod_id || null,
      client_id: responseData.client_id || null,
    };
  } catch (error: any) {
    if (error.message && error.message.includes('AgentMail API')) {
      throw error;
    }
    console.error('[AgentMail] Error verifying domain:', error);
    throw new Error(`Failed to verify domain via AgentMail: ${error.message || 'Unknown error'}`);
  }
}

