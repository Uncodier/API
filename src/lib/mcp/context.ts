import { z } from 'zod';

// Compatibility sentinel for clients that do not select an instance. It is
// never a history scope and must not be replaced with a fabricated UUID.
export const DEFAULT_MCP_INSTANCE_ID = 'default';

export const mcpContextSchema = z.object({
  siteId: z.string().trim().uuid(),
  instanceId: z.union([z.string().trim().uuid(), z.literal(DEFAULT_MCP_INSTANCE_ID)])
    .default(DEFAULT_MCP_INSTANCE_ID),
});