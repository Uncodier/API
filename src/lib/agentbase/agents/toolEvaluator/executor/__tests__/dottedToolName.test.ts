import { rewriteDottedToolCall, unknownToolError } from '../dottedToolName';

const reservationsTool = {
  name: 'reservations',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'get_available_slots', 'create', 'update'] },
    },
  },
};

describe('rewriteDottedToolCall', () => {
  const valid = new Set(['reservations', 'calendars']);

  it('rewrites reservations.create into reservations with action=create', () => {
    const result = rewriteDottedToolCall(
      'reservations.create',
      '{"catalog_item_id":"item-1"}',
      valid,
      [reservationsTool]
    );

    expect(result.rewritten).toBe(true);
    expect(result.name).toBe('reservations');
    expect(JSON.parse(result.arguments)).toEqual({
      catalog_item_id: 'item-1',
      action: 'create',
    });
  });

  it('rewrites reservation.create via MCP alias', () => {
    const result = rewriteDottedToolCall('reservation.create', '{}', valid, [reservationsTool]);
    expect(result.rewritten).toBe(true);
    expect(result.name).toBe('reservations');
    expect(JSON.parse(result.arguments).action).toBe('create');
  });

  it('does not overwrite an existing action', () => {
    const result = rewriteDottedToolCall(
      'reservations.create',
      '{"action":"get_available_slots"}',
      valid,
      [reservationsTool]
    );
    expect(result.rewritten).toBe(true);
    expect(JSON.parse(result.arguments).action).toBe('get_available_slots');
  });

  it('leaves unknown dotted names untouched', () => {
    const result = rewriteDottedToolCall('gmail.send', '{}', valid, [reservationsTool]);
    expect(result.rewritten).toBe(false);
    expect(result.name).toBe('gmail.send');
  });

  it('leaves invalid actions on a known tool untouched so they can fail visibly', () => {
    const result = rewriteDottedToolCall('reservations.explode', '{}', valid, [reservationsTool]);
    expect(result.rewritten).toBe(false);
    expect(result.name).toBe('reservations.explode');
  });
});

describe('unknownToolError', () => {
  it('tells the model to use action instead of a dotted name', () => {
    expect(unknownToolError('reservations.create')).toContain('name="reservations"');
    expect(unknownToolError('reservations.create')).toContain('reservations.create');
  });
});
