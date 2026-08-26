import { TOOL_CATEGORIES, type ToolLookupCategory } from '@/app/api/agents/tools/tool_lookup/assistantProtocol';

const ACTION_HINTS: Record<string, string[]> = {
  leads: ['create', 'update', 'list', 'get', 'qualify'],
  deals: ['create', 'update', 'list'],
  sales: ['create', 'update', 'list'],
  quotations: ['create', 'update', 'list'],
  quotation_items: ['create', 'update', 'list'],
  conversations: ['list', 'get'],
  messages: ['list', 'send'],
  tasks: ['create', 'update', 'list'],
  reservations: ['create', 'update', 'list'],
  content: ['create', 'update', 'list'],
  webSearch: ['search'],
  url_to_markdown: ['fetch'],
  sendEmail: ['send'],
  sendWhatsApp: ['send'],
  campaigns: ['create', 'update', 'list'],
  promotions: ['create', 'list', 'get', 'update', 'delete'],
  segments: ['create', 'update', 'list'],
  assets: ['create', 'list'],
  memories: ['list', 'save'],
};

export function listMcpCatalog(): Array<{
  name: string;
  category: ToolLookupCategory | 'other';
  actions: string[];
  description: string;
}> {
  return Object.entries(TOOL_CATEGORIES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, category]) => ({
      name,
      category,
      actions: ACTION_HINTS[name] || ['call'],
      description: `MCP tool "${name}" (${category})`,
    }));
}
