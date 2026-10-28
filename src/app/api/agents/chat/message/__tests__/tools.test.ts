jest.mock('@/app/api/agents/tools/utils/fetch-helper', () => ({
  fetchApiTool: jest.fn().mockResolvedValue({ success: true }),
  getApiBaseUrl: jest.fn().mockReturnValue('https://api.example.invalid'),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';
import { buildCustomerSupportTools } from '@/lib/services/customer-support-tool-catalog';
import { buildChatMessageTools } from '../tools';

describe('chat message tool baseline', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes the complete shared support catalog without agent configuration', () => {
    const tools = buildChatMessageTools('site-1');
    expect(tools.map(tool => tool.function.name))
      .toEqual(buildCustomerSupportTools('site-1').map(tool => tool.function.name));
    expect(tools.find(tool => tool.function.name === 'CONTACT_HUMAN').async).toBe(true);
  });

  it('retains custom and legacy tools without overriding or duplicating support tools', () => {
    const custom = { type: 'function', function: { name: 'CUSTOM_TOOL' } };
    const legacy = { type: 'function', function: { name: 'GET_LEAD_DETAILS' } };
    const tools = buildChatMessageTools('site-1', [
      { type: 'function', function: { name: 'catalog_commerce' } },
      { name: 'skill_lookup' },
      custom, custom, legacy,
    ]);
    const names = tools.map(tool => tool.function?.name || tool.name);
    expect(names).toContain('CUSTOM_TOOL');
    expect(names).toContain('GET_LEAD_DETAILS');
    expect(names).toEqual([...new Set(names)]);
    expect(tools.find(tool => tool.function?.name === 'catalog_commerce').function.execute)
      .toEqual(expect.any(Function));
  });

  it('passes the chat site to the executable catalog lookup', async () => {
    const catalog = buildChatMessageTools('site-1')
      .find(tool => tool.function.name === 'catalog_commerce');
    await catalog.function.execute({ action: 'list', search: 'química sanguínea' });
    expect(fetchApiTool).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'list', site_id: 'site-1', search: 'química sanguínea' }),
      expect.any(String),
    );
  });

  it('wires the shared baseline and price verification policy into the chat route', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/agents/chat/message/route.ts'), 'utf8');
    expect(route).toContain('const tools = buildChatMessageTools(site_id, additionalTools)');
    expect(route).toContain('contextMessage += getCommerceReservationsPolicy()');
  });
});