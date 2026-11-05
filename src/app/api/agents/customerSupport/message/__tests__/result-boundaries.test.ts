import { extractSupportResults } from '../results';
import { resolveSupportResults } from '../resolve-results';

describe('result provenance and suppression flags', () => {
  it.each([
    { type: 'tool', message: { content: 'internal' } },
    { role: 'tool', message: { content: 'internal' } },
    { tool_call_id: 'call', message: { content: 'internal' } },
    { type: 'function', content: 'internal' },
    { role: 'user', content: 'inbound' },
    { type: 'conversation', message: { content: 'internal' } },
  ])('rejects non-assistant output %#', row => {
    expect(extractSupportResults({ results: [row] }).assistantMessage).toBeUndefined();
  });

  it.each(['is_robot', 'is_transactional_message', 'is_erratic'])('preserves nested %s', key => {
    const result = extractSupportResults({ results: [
      { type: 'message', content: { message: { content: 'Hola', [key]: true } } },
      { conversation: { title: 'Greeting', [key]: false } },
    ] });
    const field = { is_robot: 'isRobot', is_transactional_message: 'isTransactionalMessage', is_erratic: 'isErratic' }[key]!;
    expect(result.assistantMessage).toBe('Hola');
    expect((result as any)[field]).toBe(true);
  });

  it('uses flags from the selected result rather than a rejected placeholder', () => {
    expect(extractSupportResults({ results: [
      { message: { content: 'No response generated', is_robot: true } },
      { message: { content: 'Hola', is_robot: false } },
    ] })).toMatchObject({ assistantMessage: 'Hola', isRobot: false });
  });

  it('retries a transient read without generating another command', async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue({ status: 'completed', results: [{ message: { content: 'Hola' } }] });
    expect(await resolveSupportResults({ results: [] }, read)).toMatchObject({ assistantMessage: 'Hola' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated read failures', async () => {
    const read = jest.fn().mockRejectedValue(new Error('unavailable'));
    expect(await resolveSupportResults({ results: [] }, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });
});