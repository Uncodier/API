/**
 * Scrapybara Tools for OpenAI Agent
 * 
 * Custom tool implementations that interact directly with Scrapybara API
 * instead of using the SDK's built-in tools.
 */

import { Tool } from './openai-agent-executor';

export interface ScrapybaraInstance {
  id: string;
  cdpUrl?: string;
}

/**
 * Direct API client for Scrapybara instance operations
 */
export class ScrapybaraInstanceClient {
  private apiKey: string;
  private baseUrl: string = 'https://api.scrapybara.com/v1';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.SCRAPYBARA_API_KEY || '';
  }

  /**
   * Execute bash command on instance
   */
  async bash(instanceId: string, command: string, workdir?: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/bash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        command,
        ...(workdir && { workdir }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bash command failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Execute computer action (mouse, keyboard, etc.)
   */
  async computer(instanceId: string, action: string, params: Record<string, any>): Promise<any> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/computer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        action,
        ...params,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Computer action failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Read file from instance
   */
  async readFile(instanceId: string, path: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/file/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Read file failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Write file to instance
   */
  async writeFile(instanceId: string, path: string, content: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/file/write`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({ path, content }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Write file failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Take screenshot of instance
   */
  async screenshot(instanceId: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/instance/${instanceId}/screenshot`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Screenshot failed: ${error}`);
    }

    return await response.json();
  }
}

/**
 * Create bash tool for OpenAI agent
 */
export function createBashTool(instance: ScrapybaraInstance): Tool {
  const client = new ScrapybaraInstanceClient();

  return {
    name: 'bash',
    description: 'Execute bash commands in the Ubuntu instance. Use this to run shell commands, install packages, manage files, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute',
        },
        workdir: {
          type: 'string',
          description: 'Optional working directory for the command',
        },
      },
      required: ['command'],
    },
    execute: async (args: Record<string, any>) => {
      const result = await client.bash(instance.id, args.command, args.workdir);
      
      // Format result similar to Scrapybara SDK
      if (result.exit_code === 0) {
        return result.output || 'Command executed successfully';
      } else {
        return `Error (exit code ${result.exit_code}): ${result.output || result.error || 'Command failed'}`;
      }
    },
  };
}

/**
 * Create computer tool for OpenAI agent
 */
export function createComputerTool(instance: ScrapybaraInstance): Tool {
  const client = new ScrapybaraInstanceClient();

  return {
    name: 'computer',
    description: 'Interact with the computer desktop using mouse and keyboard. Supports actions like click, type, move mouse, scroll, press keys, etc.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'move_mouse',
            'click_mouse',
            'drag_mouse',
            'scroll',
            'press_key',
            'type_text',
            'wait',
            'get_cursor_position',
            'screenshot',
          ],
          description: 'The computer action to perform',
        },
        coordinates: {
          type: 'array',
          items: { type: 'number' },
          description: 'Mouse coordinates [x, y] for mouse actions',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button for click actions',
        },
        path: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'number' },
          },
          description: 'Path for drag actions [[x1, y1], [x2, y2]]',
        },
        delta_x: {
          type: 'number',
          description: 'Horizontal scroll amount',
        },
        delta_y: {
          type: 'number',
          description: 'Vertical scroll amount',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keys to press',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        duration: {
          type: 'number',
          description: 'Wait duration in seconds',
        },
      },
      required: ['action'],
    },
    execute: async (args: Record<string, any>) => {
      const { action, ...params } = args;

      // Handle screenshot as special case
      if (action === 'screenshot') {
        const result = await client.screenshot(instance.id);
        return `Screenshot taken. Base64 image available.`;
      }

      const result = await client.computer(instance.id, action, params);
      
      // Format result
      if (result.success !== false) {
        return `Action ${action} completed successfully`;
      } else {
        return `Action ${action} failed: ${result.error || 'Unknown error'}`;
      }
    },
  };
}

/**
 * Create edit tool for OpenAI agent (file operations)
 */
export function createEditTool(instance: ScrapybaraInstance): Tool {
  const client = new ScrapybaraInstanceClient();

  return {
    name: 'str_replace_editor',
    description: 'Edit files in the instance. Can read, write, and modify files using string replacement.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert', 'undo_edit'],
          description: 'The edit command to execute',
        },
        path: {
          type: 'string',
          description: 'File path',
        },
        file_text: {
          type: 'string',
          description: 'Content for create command',
        },
        old_str: {
          type: 'string',
          description: 'String to replace (for str_replace)',
        },
        new_str: {
          type: 'string',
          description: 'Replacement string (for str_replace)',
        },
        insert_line: {
          type: 'number',
          description: 'Line number for insert command',
        },
        view_range: {
          type: 'array',
          items: { type: 'number' },
          description: 'Line range [start, end] for view command',
        },
      },
      required: ['command', 'path'],
    },
    execute: async (args: Record<string, any>) => {
      const { command, path, file_text, old_str, new_str, insert_line, view_range } = args;

      switch (command) {
        case 'view': {
          const result = await client.readFile(instance.id, path);
          let content = result.content || '';
          
          // Apply view_range if specified
          if (view_range && Array.isArray(view_range) && view_range.length === 2) {
            const lines = content.split('\n');
            const start = Math.max(0, view_range[0] - 1);
            const end = Math.min(lines.length, view_range[1]);
            content = lines.slice(start, end).join('\n');
          }
          
          return content;
        }

        case 'create': {
          await client.writeFile(instance.id, path, file_text || '');
          return `File created: ${path}`;
        }

        case 'str_replace': {
          const readResult = await client.readFile(instance.id, path);
          const content = readResult.content || '';
          
          if (!content.includes(old_str)) {
            return `Error: String not found in file: ${old_str}`;
          }
          
          const newContent = content.replace(old_str, new_str);
          await client.writeFile(instance.id, path, newContent);
          return `String replaced in ${path}`;
        }

        case 'insert': {
          const readResult = await client.readFile(instance.id, path);
          const lines = (readResult.content || '').split('\n');
          
          if (insert_line < 0 || insert_line > lines.length) {
            return `Error: Invalid line number ${insert_line}`;
          }
          
          lines.splice(insert_line, 0, new_str || '');
          await client.writeFile(instance.id, path, lines.join('\n'));
          return `Line inserted at ${insert_line} in ${path}`;
        }

        default:
          return `Error: Unknown command ${command}`;
      }
    },
  };
}

/**
 * Create all tools for an instance
 */
export function createScrapybaraTools(instance: ScrapybaraInstance): Tool[] {
  return [
    createBashTool(instance),
    createComputerTool(instance),
    createEditTool(instance),
  ];
}

