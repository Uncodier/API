import { resolveMcpNativeToolName } from './mcpNativeTools';

function stringifyArgs(raw: string | object | undefined): string {
  if (typeof raw === 'string') return raw || '{}';
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return '{}';
  }
}

export function parseToolArgs(raw: string | object | undefined): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...raw };
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveKnownToolName(name: string, validToolNames: Set<string>): string | null {
  const key = String(name || '').trim();
  if (!key) return null;
  if (validToolNames.has(key)) return key;
  const mcp = resolveMcpNativeToolName(key);
  if (mcp && (validToolNames.size === 0 || validToolNames.has(mcp))) return mcp;
  return null;
}

function actionEnumForTool(tools: any[], toolName: string): string[] | null {
  const toolDef = tools.find((tool) => (typeof tool === 'string' ? tool : tool?.name) === toolName);
  const actionEnum = toolDef?.parameters?.properties?.action?.enum;
  return Array.isArray(actionEnum) && actionEnum.length > 0 ? actionEnum.map(String) : null;
}

/**
 * Models often emit reservations.create instead of name=reservations + action=create.
 * Rewrite tool.action into the real tool when the base name is known.
 */
export function rewriteDottedToolCall(
  name: string,
  rawArgs: string | object | undefined,
  validToolNames: Set<string>,
  tools: any[] = []
): { name: string; arguments: string; rewritten: boolean } {
  const original = String(name || '').trim();
  const argsString = stringifyArgs(rawArgs);
  if (!original.includes('.')) {
    return { name: original, arguments: argsString, rewritten: false };
  }

  const parts = original.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { name: original, arguments: argsString, rewritten: false };
  }

  const resolvedBase = resolveKnownToolName(parts[0], validToolNames);
  if (!resolvedBase) {
    return { name: original, arguments: argsString, rewritten: false };
  }

  const action = parts[1];
  const allowed = actionEnumForTool(tools, resolvedBase);
  if (allowed && !allowed.includes(action)) {
    return { name: original, arguments: argsString, rewritten: false };
  }

  const args = parseToolArgs(rawArgs);
  if (!args.action) args.action = action;
  return { name: resolvedBase, arguments: JSON.stringify(args), rewritten: true };
}

export function rewriteOrRejectRawFunctions(functions: any[], tools: any[]): void {
  const validToolNames = new Set(
    (tools || []).map((tool: any) => (typeof tool === 'string' ? tool : tool.name))
  );
  for (const func of functions) {
    if (!func?.name || func.type === 'exclusion') continue;
    const rewritten = rewriteDottedToolCall(func.name, func.arguments ?? func.params, validToolNames, tools);
    if (rewritten.rewritten) {
      func.name = rewritten.name;
      func.arguments = rewritten.arguments;
    } else if (!validToolNames.has(func.name)) {
      func.status = 'failed';
      func.error = unknownToolError(func.name);
    }
  }
}
function _unknownToolError(name: string): string {
  const parts = [
    'Tool "',
    name,
    '" does not exist. Call the exact tool name from the available tools and pass action as an argument (example: name="reservations", arguments={"action":"create",...}). Do not use dotted names like reservations.create.'
  ];
  return parts.join('');
}

export const unknownToolError = _unknownToolError;
