/**
 * Maps Customer Support / Composio action names to in-process MCP tools.
 * Native assistantProtocol.execute() must win over the Composio v2 fallback
 * (which 410s on internal names like "calendars" and "reservations").
 */

type McpToolFactory = (siteId?: string, instanceId?: string) => {
  name: string;
  execute: (args: any) => Promise<any> | any;
};

const MCP_NATIVE_TOOL_LOADERS: Record<string, () => Promise<McpToolFactory>> = {
  calendars: async () => (await import('@/app/api/agents/tools/calendars/assistantProtocol')).calendarsTool,
  reservations: async () =>
    (await import('@/app/api/agents/tools/reservations/assistantProtocol')).reservationsTool,
  reservation_schedules: async () =>
    (await import('@/app/api/agents/tools/reservation_schedules/assistantProtocol')).reservationSchedulesTool,
  calendar_blocks: async () =>
    (await import('@/app/api/agents/tools/calendar_blocks/assistantProtocol')).calendarBlocksTool,
  block_calendar_time: async () =>
    (await import('@/app/api/agents/tools/calendar_blocks/assistantProtocol')).calendarBlocksTool,
  catalog_commerce: async () =>
    (await import('@/app/api/agents/tools/catalog_commerce/assistantProtocol')).catalogCommerceTool,
  promotions: async () =>
    (await import('@/app/api/agents/tools/promotions/assistantProtocol')).promotionsTool,
  checkout: async () => (await import('@/app/api/agents/tools/checkout/assistantProtocol')).checkoutTool,
  scheduling: async () => {
    const { schedulingTool } = await import('@/app/api/agents/tools/scheduling/assistantProtocol');
    return (siteId?: string) => schedulingTool(siteId || '', undefined);
  },
  skill_lookup: async () => {
    const { skillLookupTool } = await import('@/app/api/agents/tools/sandbox/skill-lookup-tool');
    return () => skillLookupTool();
  },
};

const MCP_NATIVE_ALIASES: Record<string, string> = {
  calendar: 'calendars',
  reservation: 'reservations',
  reservation_schedule: 'reservation_schedules',
  calendar_block: 'calendar_blocks',
  promotion: 'promotions',
  skillLookup: 'skill_lookup',
};

export function resolveMcpNativeToolName(toolName: string): string | null {
  const key = String(toolName || '').trim();
  if (!key) return null;
  if (key in MCP_NATIVE_TOOL_LOADERS) return key;
  return MCP_NATIVE_ALIASES[key] || null;
}

export function hasMcpNativeTool(toolName: string): boolean {
  return resolveMcpNativeToolName(toolName) !== null;
}

export function resolveDottedMcpCall(
  toolName: string,
  args: Record<string, any> = {}
): { name: string; args: Record<string, any> } | null {
  const key = String(toolName || '').trim();
  if (!key.includes('.')) return null;
  const parts = key.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const resolved = resolveMcpNativeToolName(parts[0]);
  if (!resolved) return null;
  const nextArgs = { ...args };
  if (!nextArgs.action) nextArgs.action = parts[1];
  return { name: resolved, args: nextArgs };
}

export async function executeMcpNativeTool(toolName: string, args: any = {}): Promise<any> {
  const resolved = resolveMcpNativeToolName(toolName);
  if (!resolved) {
    throw new Error(`No MCP mapping for tool "${toolName}"`);
  }

  const loader = MCP_NATIVE_TOOL_LOADERS[resolved];
  const factory = await loader();
  const siteId = typeof args?.site_id === 'string' ? args.site_id : undefined;
  const tool = factory(siteId);

  console.log(`[ToolExecutor] Routing "${toolName}" to MCP tool "${tool.name}"`);
  return tool.execute(args);
}
