import {
  TOOL_CATEGORIES,
  type RoutedTool,
} from '@/app/api/agents/tools/router/assistantProtocol';

export interface McpCatalogEntry {
  name: string;
  label: string;
  actions: string[];
}

interface ToolParameters {
  properties?: {
    action?: {
      enum?: unknown[];
    };
  };
}

function actionValues(parameters: ToolParameters): string[] {
  const values = parameters.properties?.action?.enum;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}

function toolLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const acronyms: Record<string, string> = {
    api: 'API',
    icp: 'ICP',
    id: 'ID',
    url: 'URL',
  };
  return words
    .map((word) => acronyms[word.toLowerCase()]
      || word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function listMcpCatalog(tools: RoutedTool[]): McpCatalogEntry[] {
  return tools
    .filter((tool) => Object.hasOwn(TOOL_CATEGORIES, tool.name))
    .map((tool) => ({
      name: tool.name,
      label: toolLabel(tool.name),
      actions: actionValues(tool.parameters || {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
