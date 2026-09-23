import { describe, expect, it } from '@jest/globals';
import { formatRunnerExecutionHistory } from '../requirement-context-history';

describe('formatRunnerExecutionHistory', () => {
  it('keeps valid context when generated-media payloads are malformed', () => {
    const result = formatRunnerExecutionHistory([
      {
        log_type: 'tool_call',
        message: 'Malformed image result',
        created_at: '2026-09-23T12:00:00.000Z',
        tool_name: 'generate_image',
        tool_result: {
          success: true,
          output: { images: { url: 'not-an-array' } },
        },
      },
      {
        log_type: 'agent_action',
        message: 'Continued working',
        created_at: '2026-09-23T12:01:00.000Z',
      },
    ]);

    expect(result).toContain('Malformed image result');
    expect(result).toContain('Continued working');
  });

  it('extracts URLs only from valid generated-media arrays', () => {
    const result = formatRunnerExecutionHistory([
      {
        log_type: 'tool_call',
        message: 'Generated assets',
        created_at: '2026-09-23T12:00:00.000Z',
        tool_name: 'generate_image',
        tool_result: {
          success: true,
          output: {
            images: [
              { url: 'https://example.com/a.png' },
              null,
              { unexpected: true },
            ],
          },
        },
      },
    ]);

    expect(result).toContain('https://example.com/a.png');
  });
});
