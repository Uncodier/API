/**
 * Service to interact with Composio API
 */
export class ComposioService {
  private static baseUrl = 'https://backend.composio.dev/api/v1';
  private static apiKey = process.env.COMPOSIO_PROJECT_API_KEY || '';

  // Check if API key is available
  static hasValidApiKey() {
    return !!this.apiKey;
  }

  /**
   * Get all available integrations from Composio
   * @returns Promise with the list of integrations
   */
  static async getIntegrations() {
    console.log('[ComposioService] Getting integrations');
    console.log(`[ComposioService] Base URL: ${this.baseUrl}`);
    console.log(`[ComposioService] API Key available: ${!!this.apiKey}`);
    console.log(`[ComposioService] API Key length: ${this.apiKey?.length || 0}`);

    // Check if API key is available
    if (!this.hasValidApiKey()) {
      console.error('[ComposioService] API key is missing. Please check your environment variables.');
      throw new Error('Composio API key is not configured.');
    }
    
    const url = `${this.baseUrl}/apps`;
    const options = {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      cache: 'no-store' as RequestCache,
      next: { revalidate: 0 }
    };

    console.log(`[ComposioService] Calling URL: ${url}`);
    
    try {
      const response = await fetch(url, options);
      console.log(`[ComposioService] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        console.error(`[ComposioService] Error response: ${response.status} ${response.statusText}`);
        const errorData = await response.json().catch(() => {
          console.error('[ComposioService] Failed to parse error response as JSON');
          return null;
        });
        console.error('[ComposioService] Error data:', errorData);
        throw new Error(`Failed to fetch apps: ${response.status} ${response.statusText}${errorData ? ` - ${JSON.stringify(errorData)}` : ''}`);
      }
      
      const data = await response.json();
      console.log(`[ComposioService] Successfully fetched ${data ? data.length : 0} apps`);
      return data;
    } catch (error) {
      console.error('[ComposioService] Error fetching Composio apps:', error);
      console.error('[ComposioService] Stack trace:', error instanceof Error ? error.stack : 'No stack available');
      throw error;
    }
  }

  /**
   * Get a specific integration by ID
   * @param integrationId The ID of the integration to fetch
   * @returns Promise with the integration details
   */
  static async getIntegrationById(integrationId: string) {
    console.log(`[ComposioService] Getting integration by ID: ${integrationId}`);
    console.log(`[ComposioService] API Key available: ${!!this.apiKey}`);
    console.log(`[ComposioService] API Key length: ${this.apiKey?.length || 0}`);
    
    // Check if API key is available
    if (!this.hasValidApiKey()) {
      console.error('[ComposioService] API key is missing. Please check your environment variables.');
      throw new Error('Composio API key is not configured.');
    }
    
    const url = `${this.baseUrl}/integrations/${integrationId}`;
    const options = {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      cache: 'no-store' as RequestCache,
      next: { revalidate: 0 }
    };

    console.log(`[ComposioService] Calling URL: ${url}`);
    
    try {
      const response = await fetch(url, options);
      console.log(`[ComposioService] Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        console.error(`[ComposioService] Error response: ${response.status} ${response.statusText}`);
        const errorData = await response.json().catch(() => {
          console.error('[ComposioService] Failed to parse error response as JSON');
          return null;
        });
        console.error('[ComposioService] Error data:', errorData);
        throw new Error(`Failed to fetch integration: ${response.status} ${response.statusText}${errorData ? ` - ${JSON.stringify(errorData)}` : ''}`);
      }
      
      const data = await response.json();
      console.log('[ComposioService] Successfully fetched integration details');
      return data;
    } catch (error) {
      console.error(`[ComposioService] Error fetching Composio integration ${integrationId}:`, error);
      console.error('[ComposioService] Stack trace:', error instanceof Error ? error.stack : 'No stack available');
      throw error;
    }
  }
}

// CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ComposioService };
} 