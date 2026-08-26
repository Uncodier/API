import { executeMcpNativeTool, hasMcpNativeTool, resolveMcpNativeToolName } from '../mcpNativeTools';
import { fetchApiTool } from '@/app/api/agents/tools/utils/fetch-helper';

jest.mock('@/app/api/agents/tools/utils/fetch-helper', () => ({
  fetchApiTool: jest.fn(),
  fetchApiToolGet: jest.fn(),
  getApiBaseUrl: jest.fn(() => 'http://127.0.0.1:3001'),
}));

const mockedFetch = fetchApiTool as jest.MockedFunction<typeof fetchApiTool>;

describe('mcpNativeTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps customer-support Composio names to MCP tools', () => {
    expect(hasMcpNativeTool('reservations')).toBe(true);
    expect(hasMcpNativeTool('calendars')).toBe(true);
    expect(hasMcpNativeTool('checkout')).toBe(true);
    expect(hasMcpNativeTool('skill_lookup')).toBe(true);
    expect(hasMcpNativeTool('promotions')).toBe(true);
    expect(resolveMcpNativeToolName('reservation')).toBe('reservations');
    expect(resolveMcpNativeToolName('promotion')).toBe('promotions');
    expect(hasMcpNativeTool('GOOGLECALENDAR_LIST_EVENTS')).toBe(false);
  });

  it('executes reservations through the MCP API helper, not Composio', async () => {
    mockedFetch.mockResolvedValue({ success: true, slots: [{ start: '2026-08-26T17:00:00Z' }] });

    const result = await executeMcpNativeTool('reservations', {
      action: 'get_available_slots',
      site_id: 'site-1',
      catalog_item_id: 'cat-emmanuel',
      from_date: '2026-08-26',
      to_date: '2026-08-27',
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      '/api/agents/tools/reservations',
      expect.objectContaining({
        action: 'get_available_slots',
        site_id: 'site-1',
        catalog_item_id: 'cat-emmanuel',
      }),
      expect.any(String)
    );
    expect(result).toEqual({ success: true, slots: [{ start: '2026-08-26T17:00:00Z' }] });
  });

  it('executes promotions through the MCP API helper, not Composio', async () => {
    mockedFetch.mockResolvedValue({ success: true, promotions: [] });

    const result = await executeMcpNativeTool('promotion', {
      action: 'list',
      site_id: 'site-1',
      status: 'active',
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      '/api/agents/tools/promotions',
      expect.objectContaining({
        action: 'list',
        site_id: 'site-1',
        status: 'active',
      }),
      expect.any(String)
    );
    expect(result).toEqual({ success: true, promotions: [] });
  });
});
