import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MCP_INSTANCE_ID, mcpContextSchema } from '../context';

describe('MCP context syntax (not authorization)', () => {
  const siteId = randomUUID();
  it('keeps a missing instance as a sentinel, not a generated UUID', () => {
    expect(mcpContextSchema.parse({ siteId })).toEqual({ siteId, instanceId: DEFAULT_MCP_INSTANCE_ID });
  });
  it('normalizes actual UUIDs', () => {
    const instanceId = randomUUID();
    expect(mcpContextSchema.parse({ siteId: ` ${siteId} `, instanceId: ` ${instanceId} ` })).toEqual({ siteId, instanceId });
  });
  it.each([null, '', 'arbitrary', 1])('rejects an invalid explicit instance: %s', instanceId => {
    expect(mcpContextSchema.safeParse({ siteId, instanceId }).success).toBe(false);
  });
  it.each([undefined, null, '', 'default', 'arbitrary'])('requires a real site UUID: %s', site => {
    expect(mcpContextSchema.safeParse({ siteId: site }).success).toBe(false);
  });
});