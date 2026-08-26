import { executeTools } from '../executeTools';
import * as customToolsMap from '../customToolsMap';
import * as mcpNativeTools from '../mcpNativeTools';
import { FunctionCallStatus } from '../../types';

jest.mock('../customToolsMap', () => ({
  hasCustomTool: jest.fn(() => false),
  getCustomToolDefinition: jest.fn(),
}));

jest.mock('../mcpNativeTools', () => ({
  hasMcpNativeTool: jest.fn(() => false),
  executeMcpNativeTool: jest.fn(),
}));

describe('executeTools MCP routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (customToolsMap.hasCustomTool as jest.Mock).mockReturnValue(false);
  });

  it('routes reservations to the MCP native tool instead of Composio', async () => {
    (mcpNativeTools.hasMcpNativeTool as jest.Mock).mockReturnValue(true);
    (mcpNativeTools.executeMcpNativeTool as jest.Mock).mockResolvedValue({
      success: true,
      slots: [],
    });

    const result = await executeTools(
      [
        {
          id: 'res-1',
          type: 'function',
          status: FunctionCallStatus.INITIALIZED,
          name: 'reservations',
          arguments: JSON.stringify({
            action: 'get_available_slots',
            catalog_item_id: 'cat-1',
            from_date: '2026-08-26',
            to_date: '2026-08-27',
          }),
        },
      ],
      {}
    );

    expect(mcpNativeTools.executeMcpNativeTool).toHaveBeenCalledWith(
      'reservations',
      expect.objectContaining({ action: 'get_available_slots' })
    );
    expect(result[0].status).toBe('success');
    expect(result[0].output).toEqual({ success: true, slots: [] });
  });

  it('routes calendars to the MCP native tool instead of Composio', async () => {
    (mcpNativeTools.hasMcpNativeTool as jest.Mock).mockReturnValue(true);
    (mcpNativeTools.executeMcpNativeTool as jest.Mock).mockResolvedValue({
      success: true,
      reservable_services: [{ name: 'EMMANUEL' }],
    });

    const result = await executeTools(
      [
        {
          id: 'cal-1',
          type: 'function',
          status: FunctionCallStatus.INITIALIZED,
          name: 'calendars',
          arguments: JSON.stringify({ action: 'list', query: 'Emmanuel' }),
        },
      ],
      {}
    );

    expect(mcpNativeTools.executeMcpNativeTool).toHaveBeenCalledWith(
      'calendars',
      expect.objectContaining({ action: 'list', query: 'Emmanuel' })
    );
    expect(result[0].status).toBe('success');
  });

  it('injects command site_id when the model omits it', async () => {
    (mcpNativeTools.hasMcpNativeTool as jest.Mock).mockReturnValue(true);
    (mcpNativeTools.executeMcpNativeTool as jest.Mock).mockResolvedValue({ success: true });

    await executeTools(
      [
        {
          id: 'cal-2',
          type: 'function',
          status: FunctionCallStatus.INITIALIZED,
          name: 'calendars',
          arguments: JSON.stringify({ action: 'list', query: 'Emmanuel' }),
        },
      ],
      {},
      { site_id: 'site-from-command' }
    );

    expect(mcpNativeTools.executeMcpNativeTool).toHaveBeenCalledWith(
      'calendars',
      expect.objectContaining({ action: 'list', query: 'Emmanuel', site_id: 'site-from-command' })
    );
  });
});
