import { describe, expect, it, jest } from '@jest/globals';
import { formatStepLogHistory } from '../step-history-builder';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

describe('formatStepLogHistory', () => {
  it('injects sanitized runtime evidence for the next repair turn', () => {
    const result = formatStepLogHistory([
      {
        log_type: 'infrastructure',
        message: 'Step 2 runtime probe failed',
        details: {
          event: 'cron_infra_runtime_probe',
          server_log_excerpt: [
            'POST /api/orders',
            'authorization: Bearer private-token',
            'TypeError: Cannot read properties of undefined',
            '    at createOrder (/vercel/sandbox/src/orders.ts:42:9)',
          ].join('\n'),
        },
      },
    ]);

    expect(result).toContain('[Runtime Evidence: cron_infra_runtime_probe]');
    expect(result).toContain('TypeError: Cannot read properties of undefined');
    expect(result).toContain('/vercel/sandbox/src/orders.ts:42:9');
    expect(result).not.toContain('private-token');
  });

  it('injects an enforceable guard after three repeated tool actions', () => {
    const repeated = Array.from({ length: 3 }, (_, index) => ({
      log_type: 'tool_call',
      tool_name: 'sandbox_read_file',
      tool_args: {
        path: '/vercel/sandbox/src/app/protected/layout.tsx',
        thought_process: `attempt ${index}`,
      },
    }));

    const result = formatStepLogHistory(repeated);

    expect(result).toContain('[Action Loop Guard]');
    expect(result).toContain('ACTION_LOOP_BLOCKED_ACTION:');
    expect(result).toContain('sandbox_read_file');
  });
});
