import {
  TOOL_CATEGORIES,
  type RoutedTool,
  type ToolCategory,
} from '@/app/api/agents/tools/router/assistantProtocol';

export interface McpCatalogSchema {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
}

export interface McpCatalogEntry {
  name: string;
  category: ToolCategory | 'other';
  actions: string[];
  description: string;
  parameters: McpCatalogSchema;
}

function actionValues(parameters: McpCatalogSchema): string[] {
  const values = parameters.properties?.action?.enum;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}

export function listMcpCatalog(tools: RoutedTool[]): McpCatalogEntry[] {
  return tools
    .filter((tool) => Object.hasOwn(TOOL_CATEGORIES, tool.name))
    .map((tool) => {
      const parameters = (tool.parameters || {}) as McpCatalogSchema;
      return {
        name: tool.name,
        category: TOOL_CATEGORIES[tool.name] || 'other',
        actions: actionValues(parameters),
        description: tool.description,
        parameters,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
