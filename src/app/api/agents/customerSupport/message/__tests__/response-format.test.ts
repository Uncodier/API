import { extractSupportResults } from '../results';
import { selectSupportResponseFormat, supportResponseFormatContext } from '../response-format';
import { validateResponseFormat } from '@/lib/services/channels/response-format';

describe('support response format selection', () => {
  it.each(['whatsapp', 'telegram', 'messenger'])('allows contextual audio on %s without a length heuristic', channel => {
    for (const content of ['Hi', 'An explanation. '.repeat(100)]) {
      expect(selectSupportResponseFormat({ channel, content, model: 'audio' })).toBe('audio');
      expect(selectSupportResponseFormat({ channel, content, model: 'text' })).toBe('text');
    }
  });

  it.each([undefined, null, 'video', {}, 1])('defaults malformed or absent model choices safely to text %#', model => {
    expect(selectSupportResponseFormat({ channel: 'whatsapp', content: 'Hello', model })).toBe('text');
  });

  it.each(['website', 'email', 'instagram', 'sms', undefined])('never follows model audio on unsupported %s', channel => {
    expect(selectSupportResponseFormat({ channel, content: 'Hello', model: 'audio' })).toBe('text');
  });

  it('enforces explicit request precedence both ways', () => {
    expect(selectSupportResponseFormat({ channel: 'telegram', content: 'Hello', model: 'audio', explicit: 'text' })).toBe('text');
    expect(selectSupportResponseFormat({ channel: 'telegram', content: 'Hello', model: 'text', explicit: 'audio' })).toBe('audio');
  });

  it('bounds audio scripts without truncating or overriding explicit audio', () => {
    expect(selectSupportResponseFormat({ channel: 'telegram', content: 'a'.repeat(4000), model: 'audio' })).toBe('audio');
    expect(selectSupportResponseFormat({ channel: 'telegram', content: 'a'.repeat(4001), model: 'audio' })).toBe('text');
    expect(() => selectSupportResponseFormat({ channel: 'telegram', content: 'a'.repeat(4001), model: 'text', explicit: 'audio' }))
      .toThrow('CUSTOMER_SUPPORT_AUDIO_TOO_LONG');
  });

  it.each([null, '', 'AUDIO', 'video', 1, {}, ['text']])('rejects invalid explicit values %#', value => {
    expect(() => validateResponseFormat(value, 'whatsapp')).toThrow();
  });

  it('documents contextual discretion, safe text and downstream-only delivery', () => {
    const context = supportResponseFormatContext('whatsapp');
    expect(context).toContain('Default safely to text');
    expect(context).toContain('Do not choose audio merely because');
    expect(context).toContain('4000 characters');
    expect(context).toContain('Never generate speech, call TTS, or send/dispatch');
    expect(supportResponseFormatContext('email')).toContain('text replies only');
    expect(supportResponseFormatContext('telegram', 'audio')).toContain('explicitly requires response_format="audio"');
  });
});

describe('format provenance follows only the selected response', () => {
  it.each([
    { message: { content: 'Hello', response_format: 'audio' } },
    { type: 'message', content: { message: { content: 'Hello', response_format: 'audio' } } },
    { type: 'text', content: { content: 'Hello', response_format: 'audio' } },
    { role: 'assistant', content: 'Hello', response_format: 'audio' },
    { text: 'Hello', response_format: 'audio' },
  ])('extracts supported target shapes %#', row => {
    expect(extractSupportResults({ results: [row] })).toMatchObject({ assistantMessage: 'Hello', responseFormat: 'audio' });
  });

  it('ignores tools, rejected placeholders, other messages and conversation format', () => {
    const results = [
      { type: 'tool', message: { content: 'Tool output', response_format: 'audio' } },
      { role: 'tool', content: 'Tool output', response_format: 'audio' },
      { tool_call_id: 'call', message: { content: 'Tool output', response_format: 'audio' } },
      { message: { content: 'No response generated', response_format: 'audio' } },
      { message: { content: 'Hello' } },
      { message: { content: 'Unselected', response_format: 'audio' } },
      { conversation: { title: 'Title', response_format: 'audio' } },
    ];
    expect(extractSupportResults({ results }).assistantMessage).toBe('Hello');
    expect(extractSupportResults({ results }).responseFormat).toBeUndefined();
  });

  it('prefers the message target format over wrapper metadata and rejects malformed target format', () => {
    expect(extractSupportResults({ results: [
      { response_format: 'audio', message: { content: 'Hello', response_format: 'text' } },
    ] }).responseFormat).toBe('text');
    expect(extractSupportResults({ results: [
      { response_format: 'audio', message: { content: 'Hello', response_format: 'video' } },
    ] }).responseFormat).toBeUndefined();
  });
});