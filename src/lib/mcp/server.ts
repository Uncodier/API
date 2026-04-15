/**
 * Shared MCP server factory: builds a Server with tools/list and tools/call handlers
 * using getAssistantTools. Used by both stdio (mcp-server/index.ts) and HTTP (api/mcp/route.ts).
 */

import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { shouldUseRemoteApi } from '@/lib/mcp/remote-client';

/**
 * Levenshtein distance between two strings (case-insensitive).
 */
function levenshtein(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find the most similar tool names for a given unknown name.
 * Uses Levenshtein distance + substring matching.
 * Returns up to 3 suggestions with their descriptions.
 */
function findSimilarTools(
  unknownName: string,
  tools: { name: string; description?: string }[],
  maxSuggestions = 3
): { name: string; description: string }[] {
  const query = unknownName.toLowerCase().replace(/[-_ ]/g, '');

  const scored = tools.map((t) => {
    const normalized = t.name.toLowerCase().replace(/[-_ ]/g, '');
    const dist = levenshtein(query, normalized);
    const maxLen = Math.max(query.length, normalized.length);
    const similarity = maxLen === 0 ? 1 : 1 - dist / maxLen;

    const substringBonus =
      normalized.includes(query) || query.includes(normalized) ? 0.3 : 0;

    // Boost when individual words in the query appear in the tool name
    const queryWords = unknownName.toLowerCase().split(/[-_ ]+/);
    const nameWords = t.name.toLowerCase().split(/[-_ ]+/);
    const wordOverlap = queryWords.filter((w) =>
      nameWords.some((nw) => nw.includes(w) || w.includes(nw))
    ).length;
    const wordBonus = queryWords.length > 0 ? (wordOverlap / queryWords.length) * 0.2 : 0;

    return {
      name: t.name,
      description: t.description ?? '',
      score: similarity + substringBonus + wordBonus,
    };
  });

  return scored
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map(({ name, description }) => ({ name, description }));
}

/**
 * Formats an "unknown tool" error with suggestions for the agent.
 */
function formatUnknownToolError(
  name: string,
  tools: { name: string; description?: string }[]
): string {
  const suggestions = findSimilarTools(name, tools);
  const lines = [`Unknown tool: "${name}".`];

  if (suggestions.length > 0) {
    lines.push('');
    lines.push('Did you mean one of these?');
    for (const s of suggestions) {
      lines.push(`  - "${s.name}": ${s.description}`);
    }
    lines.push('');
    lines.push('Call the correct tool name from the list above.');
  } else {
    lines.push('');
    lines.push(
      'No similar tool found. Use "tools/list" to see all available tools.'
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parameter validation helpers
// ---------------------------------------------------------------------------

interface SchemaInfo {
  properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
  required: string[];
}

/**
 * Extract property names, types, enums, and required list from a tool's
 * parameter schema (works with both plain JSON Schema objects and Zod).
 */
function extractSchemaInfo(
  tool: { parameters?: Record<string, unknown> | z.ZodType<unknown> }
): SchemaInfo {
  const schema = getInputSchema(tool as any);
  const props = (schema.properties ?? {}) as Record<string, any>;
  const required = (schema.required ?? []) as string[];
  const properties: SchemaInfo['properties'] = {};
  for (const [key, val] of Object.entries(props)) {
    properties[key] = {
      type: val?.type,
      enum: val?.enum,
      description: val?.description,
    };
  }
  return { properties, required };
}

/**
 * Find the closest matching parameter name from valid names.
 */
function suggestParam(unknown: string, validNames: string[]): string | null {
  const items = validNames.map((v) => ({
    name: v,
    dist: levenshtein(unknown, v),
  }));
  items.sort((a, b) => a.dist - b.dist);
  const best = items[0];
  if (!best) return null;
  const threshold = Math.max(best.name.length, unknown.length) * 0.5;
  return best.dist <= threshold ? best.name : null;
}

interface ParamIssue {
  type: 'missing_required' | 'unknown_param';
  param: string;
  suggestion?: string;
  description?: string;
}

/**
 * Validate tool arguments against the schema before execution.
 * Returns a list of issues (empty = valid).
 */
function validateToolArgs(
  args: Record<string, unknown>,
  schema: SchemaInfo
): ParamIssue[] {
  const issues: ParamIssue[] = [];
  const validNames = Object.keys(schema.properties);

  for (const req of schema.required) {
    if (args[req] === undefined || args[req] === null) {
      issues.push({
        type: 'missing_required',
        param: req,
        description: schema.properties[req]?.description,
      });
    }
  }

  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) {
      const suggestion = suggestParam(key, validNames);
      issues.push({
        type: 'unknown_param',
        param: key,
        suggestion: suggestion ?? undefined,
      });
    }
  }

  return issues;
}

/**
 * Build a human-readable error for parameter validation failures,
 * including the full expected schema so the agent can self-correct.
 */
function formatParamErrors(
  toolName: string,
  issues: ParamIssue[],
  schema: SchemaInfo
): string {
  const lines = [`Tool "${toolName}" was called with invalid parameters:`];
  lines.push('');

  const missing = issues.filter((i) => i.type === 'missing_required');
  if (missing.length > 0) {
    lines.push('Missing required parameters:');
    for (const m of missing) {
      const desc = m.description ? ` — ${m.description}` : '';
      lines.push(`  - "${m.param}"${desc}`);
    }
  }

  const unknown = issues.filter((i) => i.type === 'unknown_param');
  if (unknown.length > 0) {
    if (missing.length > 0) lines.push('');
    lines.push('Unknown parameters:');
    for (const u of unknown) {
      const hint = u.suggestion ? ` → did you mean "${u.suggestion}"?` : '';
      lines.push(`  - "${u.param}"${hint}`);
    }
  }

  lines.push('');
  lines.push('Expected parameters:');
  for (const [key, info] of Object.entries(schema.properties)) {
    const req = schema.required.includes(key) ? ' (required)' : '';
    const enumVals = info.enum ? ` [${info.enum.join(', ')}]` : '';
    const desc = info.description ? ` — ${info.description}` : '';
    lines.push(`  - "${key}"${req}${enumVals}${desc}`);
  }

  lines.push('');
  lines.push('Fix the parameters and try again.');
  return lines.join('\n');
}

/**
 * Enrich an execution error with the tool's expected schema
 * so the agent can self-correct.
 */
function formatExecutionError(
  toolName: string,
  errorMessage: string,
  schema: SchemaInfo
): string {
  const lines = [`Tool "${toolName}" failed: ${errorMessage}`];

  if (Object.keys(schema.properties).length > 0) {
    lines.push('');
    lines.push('Expected parameters:');
    for (const [key, info] of Object.entries(schema.properties)) {
      const req = schema.required.includes(key) ? ' (required)' : '';
      const enumVals = info.enum ? ` [${info.enum.join(', ')}]` : '';
      const desc = info.description ? ` — ${info.description}` : '';
      lines.push(`  - "${key}"${req}${enumVals}${desc}`);
    }
    lines.push('');
    lines.push('Review the error and expected parameters, then try again.');
  }

  return lines.join('\n');
}

export function getInputSchema(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | z.ZodType<unknown>;
}): Record<string, unknown> {
  const params = tool.parameters;
  if (!params) {
    return { type: 'object', properties: {} };
  }
  const isZod =
    typeof params === 'object' && params !== null && '_def' in params;
  if (isZod) {
    return zodToJsonSchema(params as z.ZodType<unknown>, {
      target: 'openApi3',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
  }
  return (params as Record<string, unknown>) ?? { type: 'object', properties: {} };
}

/**
 * Creates an MCP Server with tools/list and tools/call handlers for the given context.
 */
export function createMcpServer(
  siteId: string,
  userId: string | undefined,
  instanceId: string,
  customTools: any[] = []
): Server {
  const tools = getAssistantTools(siteId, userId, instanceId, customTools);

  const server = new Server(
    {
      name: 'uncodie-tools',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // 🌐 PROXY MODO REMOTO PARA LISTA DE HERRAMIENTAS
    if (shouldUseRemoteApi()) {
      try {
        const apiUrl = process.env.API_URL?.replace(/\/$/, '');
        if (!apiUrl) throw new Error('API_URL is missing but remote mode is enabled');
        
        const apiKey = process.env.REST_API_KEY;
        const url = `${apiUrl}/api/mcp`;
        
        console.error(`[MCP Remote] Proxying tools/list to ${url}`);
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'x-mcp-site-id': siteId,
            ...(userId ? { 'x-mcp-user-id': userId } : {}),
            'x-mcp-instance-id': instanceId,
            ...(apiKey ? { 
              'x-api-key': apiKey,
              'Authorization': `Bearer ${apiKey}`
            } : {})
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {}
          })
        });
        
        if (response.ok) {
          const text = await response.text();
          try {
            const json = JSON.parse(text);
            if (json.result) return json.result;
          } catch (e) {
            console.error(`[MCP Remote] Invalid JSON from remote for tools/list:`, text.substring(0, 200));
          }
        }
      } catch (err) {
        console.error(`[MCP Remote] Failed to proxy tools/list, falling back to local list:`, err);
      }
    }

    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: getInputSchema(tool),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    // 🌐 PROXY MODO REMOTO PARA EJECUCIÓN DE HERRAMIENTAS
    if (shouldUseRemoteApi()) {
      try {
        const apiUrl = process.env.API_URL?.replace(/\/$/, '');
        if (!apiUrl) throw new Error('API_URL is missing but remote mode is enabled');
        
        const apiKey = process.env.REST_API_KEY;
        const url = `${apiUrl}/api/mcp`;
        
        console.error(`[MCP Remote] Proxying execution of tool "${name}" to ${url}`);
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'x-mcp-site-id': siteId,
            ...(userId ? { 'x-mcp-user-id': userId } : {}),
            'x-mcp-instance-id': instanceId,
            ...(apiKey ? { 
              'x-api-key': apiKey,
              'Authorization': `Bearer ${apiKey}`
            } : {})
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name,
              arguments: args
            }
          })
        });
        
        if (!response.ok) {
           const errorText = await response.text();
           return {
             content: [{ type: 'text', text: `Remote MCP Error: ${response.status} ${response.statusText} - ${errorText}` }],
             isError: true
           };
        }
        
        const responseText = await response.text();
        let json;
        try {
          json = JSON.parse(responseText);
        } catch (e) {
          return {
            content: [{ type: 'text', text: `Remote MCP returned invalid JSON (Status: ${response.status} ${response.statusText}):\n\n${responseText.substring(0, 500)}` }],
            isError: true
          };
        }
        
        if (json.error) {
           return {
             content: [{ type: 'text', text: json.error.message || JSON.stringify(json.error) }],
             isError: true
           };
        }
        
        return json.result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Failed to execute remote tool ${name}: ${message}` }],
          isError: true,
        };
      }
    }

    const tool = tools.find((t) => t.name === name);
    if (!tool?.execute) {
      return {
        content: [{ type: 'text', text: formatUnknownToolError(name, tools) }],
        isError: true,
      };
    }

    const schema = extractSchemaInfo(tool);
    const safeArgs = args ?? {};
    const issues = validateToolArgs(safeArgs as Record<string, unknown>, schema);

    if (issues.length > 0) {
      return {
        content: [{ type: 'text', text: formatParamErrors(name, issues, schema) }],
        isError: true,
      };
    }

    try {
      const result = await tool.execute(safeArgs);
      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: formatExecutionError(name, message, schema) }],
        isError: true,
      };
    }
  });

  return server;
}
