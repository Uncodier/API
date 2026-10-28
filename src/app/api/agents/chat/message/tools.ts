import { buildCustomerSupportTools } from '@/lib/services/customer-support-tool-catalog';

/** Keep chat's baseline in sync with support, retaining additional agent tools. */
export function buildChatMessageTools(siteId: string, additionalTools: any[] = []): any[] {
  const tools: any[] = [...buildCustomerSupportTools(siteId)];
  const names = new Set(tools.map(tool => tool.function.name));

  for (const tool of additionalTools) {
    const name = tool.type === 'function' ? tool.function?.name : tool.name;
    if (name && names.has(name)) continue;
    tools.push(tool);
    if (name) names.add(name);
  }

  return tools;
}