import { prepareToolsForExecution } from '../responseProcessor';

const reservationsTool = {
  name: 'reservations',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'get_available_slots', 'create', 'update'] },
    },
  },
};

describe('prepareToolsForExecution', () => {
  it('rewrites dotted reservations.create into an executable reservations call', () => {
    const prepared = prepareToolsForExecution(
      [
        {
          id: 'call_1',
          type: 'function',
          status: 'required',
          name: 'reservations.create',
          arguments: '{"catalog_item_id":"item-1","lead_id":"lead-1"}',
        },
      ],
      [reservationsTool]
    );

    expect(prepared.rejected).toHaveLength(0);
    expect(prepared.executable).toHaveLength(1);
    expect(prepared.executable[0].name).toBe('reservations');
    expect(JSON.parse(prepared.executable[0].arguments as string).action).toBe('create');
  });

  it('rejects unknown tool names as failed so the completion loop can retry', () => {
    const prepared = prepareToolsForExecution(
      [
        {
          id: 'call_2',
          type: 'function',
          status: 'required',
          name: 'reservations.explode',
          arguments: '{}',
        },
      ],
      [reservationsTool]
    );

    expect(prepared.executable).toHaveLength(0);
    expect(prepared.rejected).toHaveLength(1);
    expect(prepared.rejected[0].status).toBe('failed');
    expect(String(prepared.rejected[0].error)).toContain('does not exist');
  });
});
