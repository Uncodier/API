/**
 * Scrapybara Instance Manager
 * 
 * Direct API client for managing Scrapybara instances without using the SDK.
 * Provides methods for instance lifecycle, browser control, and authentication.
 */

export interface InstanceOptions {
  timeoutHours?: number;
}

export interface BrowserStartResult {
  cdpUrl: string;
  wsUrl?: string;
}

export interface AuthSession {
  authStateId: string;
  name: string;
  domain: string;
}

export interface Instance {
  id: string;
  status: 'starting' | 'running' | 'paused' | 'stopped';
  type: 'ubuntu' | 'browser' | 'windows';
  cdpUrl?: string;
}

/**
 * Custom Scrapybara client that interacts directly with the API
 */
export class ScrapybaraInstanceManager {
  private apiKey: string;
  private baseUrl: string = 'https://api.scrapybara.com/v1';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.SCRAPYBARA_API_KEY || '';
  }

  /**
   * Start a new Ubuntu instance
   */
  async startUbuntu(options: InstanceOptions = {}): Promise<Instance> {
    const response = await fetch(`${this.baseUrl}/instance/ubuntu`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        timeout_hours: options.timeoutHours || 1,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start Ubuntu instance: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.instance_id || data.id,
      status: 'running',
      type: 'ubuntu',
    };
  }

  /**
   * Start a browser-only instance
   */
  async startBrowser(options: InstanceOptions = {}): Promise<Instance> {
    const response = await fetch(`${this.baseUrl}/instance/browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        timeout_hours: options.timeoutHours || 1,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start browser instance: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.instance_id || data.id,
      status: 'running',
      type: 'browser',
    };
  }

  /**
   * Get existing instance by ID
   */
  async getInstance(instanceId: string): Promise<Instance> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get instance: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.instance_id || data.id,
      status: data.status,
      type: data.type || 'ubuntu',
      cdpUrl: data.cdp_url,
    };
  }

  /**
   * Stop an instance
   */
  async stopInstance(instanceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/stop`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to stop instance: ${error}`);
    }
  }

  /**
   * Pause an instance
   */
  async pauseInstance(instanceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/pause`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to pause instance: ${error}`);
    }
  }

  /**
   * Resume a paused instance
   */
  async resumeInstance(instanceId: string, options: InstanceOptions = {}): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/resume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        timeout_hours: options.timeoutHours || 1,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to resume instance: ${error}`);
    }
  }

  /**
   * Start browser in an instance
   */
  async startBrowserInInstance(instanceId: string): Promise<BrowserStartResult> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/browser/start`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start browser: ${error}`);
    }

    const data = await response.json();
    return {
      cdpUrl: data.cdp_url,
      wsUrl: data.ws_url,
    };
  }

  /**
   * Stop browser in an instance
   */
  async stopBrowserInInstance(instanceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/browser/stop`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to stop browser: ${error}`);
    }
  }

  /**
   * Save browser authentication state
   */
  async saveBrowserAuth(instanceId: string, name: string): Promise<AuthSession> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/browser/auth/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to save browser auth: ${error}`);
    }

    const data = await response.json();
    return {
      authStateId: data.auth_state_id,
      name: data.name,
      domain: data.domain || '',
    };
  }

  /**
   * Apply authentication to browser
   */
  async authenticateBrowser(instanceId: string, authStateId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/browser/auth/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        auth_state_id: authStateId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to authenticate browser: ${error}`);
    }
  }

  /**
   * Get stream URL for instance
   */
  async getStreamUrl(instanceId: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/stream_url`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get stream URL: ${error}`);
    }

    const data = await response.json();
    return data.stream_url;
  }

  /**
   * Set environment variables in instance
   */
  async setEnvironmentVariables(instanceId: string, variables: Record<string, string>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/env/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(variables),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to set environment variables: ${error}`);
    }
  }

  /**
   * Get environment variables from instance
   */
  async getEnvironmentVariables(instanceId: string): Promise<Record<string, string>> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/env/get`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get environment variables: ${error}`);
    }

    const data = await response.json();
    return data.variables || {};
  }

  /**
   * Delete environment variables from instance
   */
  async deleteEnvironmentVariables(instanceId: string, keys: string[]): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/env/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({ keys }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete environment variables: ${error}`);
    }
  }
}

