import { prepareMessagesFromCommand, validateAndNormalizeTools } from '../messageFormatter';
import { supportAttachmentContext } from '@/lib/services/customer-support-attachments';
import type { DbCommand } from '@/lib/agentbase/models/types';

describe('tool evaluator multimodal content', () => {
  const image = 'https://files.example.test/photo.jpg';
  const format = (context: string) => prepareMessagesFromCommand({
    id: 'formatter-test', agent_background: 'Support instructions', context, tools: [],
    task: 'Evaluate tools', status: 'pending', user_id: 'test-user',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  } satisfies DbCommand);
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test.each(['Current message: explain this\n\n', 'Explain this attachment\n'])('preserves image parts with context %s', prefix => {
    const messages = format(prefix + supportAttachmentContext([{ url: image, type: 'image' }]));
    expect(messages.find(message => message.role === 'user')?.content)
      .toEqual(expect.arrayContaining([{ type: 'image_url', image_url: { url: image } }]));
    expect(messages.filter(message => message.role === 'system').every(message => typeof message.content === 'string')).toBe(true);
  });
  test('keeps extracted text as a string', () => {
    expect(format('Current message: hello\n\nHistory')[1].content).toBe('hello');
  });
  test('keeps fallback context as a string', () => {
    expect(format('hello')[1].content).toBe('hello');
  });
});

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
