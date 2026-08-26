import { validateAndNormalizeTools } from '../messageFormatter';

describe('validateAndNormalizeTools', () => {
  it('keeps native MCP execute() when flattening OpenAI function format', () => {
    const execute = jest.fn();
    const normalized = validateAndNormalizeTools([
      {
        type: 'function',
        function: {
          name: 'reservations',
          description: 'Manage capacity slots',
          parameters: { type: 'object', properties: {} },
          execute,
        },
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].name).toBe('reservations');
    expect(normalized[0].execute).toBe(execute);
  });
});
