/**
 * Icypeas API Service
 * Handles communication with Icypeas API for email discovery
 */

const ICYPEAS_BASE_URL = 'https://app.icypeas.com/api';

export interface EmailSearchParams {
  firstname?: string;
  lastname?: string;
  domainOrCompany: string;
  customobject?: {
    webhookUrl?: string;
    externalId?: string;
  };
}

export interface EmailVerificationParams {
  email: string;
  customobject?: {
    webhookUrl?: string;
    externalId?: string;
  };
}

export interface IcypeasError {
  error: string;
  message?: string;
  code?: string;
}

/**
 * Search for an email address using Icypeas API
 * @param params Search parameters
 * @returns Response from Icypeas API
 * @throws Error if API call fails
 */
export async function searchEmail(params: EmailSearchParams): Promise<any> {
  const apiKey = process.env.ICYPEAS_API_KEY;

  if (!apiKey) {
    throw new Error('ICYPEAS_API_KEY environment variable is not configured');
  }

  if (!params.domainOrCompany) {
    throw new Error('domainOrCompany is required');
  }

  if (!params.firstname && !params.lastname) {
    throw new Error('Either firstname or lastname must be provided');
  }

  const url = `${ICYPEAS_BASE_URL}/email-search`;

  console.log(`[Icypeas] Searching email for ${params.firstname} ${params.lastname} at ${params.domainOrCompany}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    
    // NOTE: If auth fails, I might need to switch to 'Authorization': `Bearer ${apiKey}` or similar.
    // Since I can't verify, I'll add a comment.

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[Icypeas] Failed to parse response:', responseText);
      throw new Error(`Invalid JSON response from Icypeas API: ${responseText}`);
    }

    if (!response.ok) {
        console.error('[Icypeas] API error:', {
            status: response.status,
            responseData
        });
        
        if (response.status === 401) {
            throw new Error('Authentication failed: Invalid API Key');
        }
        if (response.status === 429) {
            throw new Error('Rate limit exceeded');
        }
        
        throw new Error(`Icypeas API Error: ${responseData.message || responseData.error || 'Unknown error'}`);
    }

    return responseData;

  } catch (error: any) {
    console.error('[Icypeas] Error searching email:', error);
    throw error;
  }
}

/**
 * Verify an email address using Icypeas API
 * @param params Verification parameters (email required, customobject optional)
 * @returns Response from Icypeas API
 * @throws Error if API call fails
 */
export async function verifyEmail(params: EmailVerificationParams): Promise<any> {
  const apiKey = process.env.ICYPEAS_API_KEY;

  if (!apiKey) {
    throw new Error('ICYPEAS_API_KEY environment variable is not configured');
  }

  if (!params.email) {
    throw new Error('email is required');
  }

  const url = `${ICYPEAS_BASE_URL}/email-verification`;

  console.log(`[Icypeas] Verifying email: ${params.email}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    const responseText = await response.text();
    let responseData: any;

    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[Icypeas] Failed to parse response:', responseText);
      throw new Error(`Invalid JSON response from Icypeas API: ${responseText}`);
    }

    if (!response.ok) {
      console.error('[Icypeas] API error:', {
        status: response.status,
        responseData
      });

      if (response.status === 401) {
        throw new Error('Authentication failed: Invalid API Key');
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded');
      }

      throw new Error(`Icypeas API Error: ${responseData.message || responseData.error || 'Unknown error'}`);
    }

    return responseData;

  } catch (error: any) {
    console.error('[Icypeas] Error verifying email:', error);
    throw error;
  }
}
