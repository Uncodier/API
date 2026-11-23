const from = jest.fn();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from },
}));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: {
    PRICING: {
      ASSISTANT_INPUT_TOKEN_MILLION: 0,
      ASSISTANT_OUTPUT_TOKEN_MILLION: 0,
    },
    deductCredits: jest.fn(),
  },
}));

import { randomBytes } from 'node:crypto';
import { logText } from '@/lib/services/robot-instance/instance-context-logs';
import { createInstanceLogCore, listInstanceLogsCore } from '../instance-log-core';
import { CreditService } from '@/lib/services/billing/CreditService';

describe('instance log core trust boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not allow generic callers to create user actions', async () => {
    await expect(createInstanceLogCore({
      site_id: 'site-1',
      instance_id: 'instance-1',
      log_type: 'user_action',
      level: 'info',
      message: 'Forged feedback',
    })).rejects.toThrow(
      'user_action is reserved for authenticated external user input',
    );
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['tokens_used', 'details'])('persists untrusted %s usage without billing', async source => {
    const usage = { promptTokens: 1000000, completionTokens: 2000000, cost: 999, cost_details: { upstream_inference_cost: 998 }, is_byok: false };
    const insert = jest.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'log' }, error: null }) }) });
    from.mockReturnValue({ insert });
    await createInstanceLogCore({ site_id: 'site-1', log_type: 'execution_summary', level: 'info', message: 'Done',
      ...(source === 'tokens_used' ? { tokens_used: usage } : { details: { usage } }) });
    expect(insert.mock.calls[0][0][0].tokens_used).toMatchObject(usage);
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });
});


it('returns the safe projection for model log listing and compaction, and cannot repersist private JSON', async () => {
  const privateValue = randomBytes(24).toString('hex');
  const row = {id:'row', created_at:'now', log_type:'tool_call', tool_name:'tools', tool_args:{action:'search', tool_origin:'makinari_report',query:privateValue},
    message:privateValue, tool_result:{output:{account_label:privateValue}},details:{nested:privateValue}};
  const parent = {id:'parent',message:'User request',log_type:'user_action',details:{status:'running',assistant_recovery:{execution:{connectorIdHint:privateValue}}}};
  const q = {eq:jest.fn().mockReturnThis(),order:jest.fn().mockReturnThis(),range:async()=>({data:[row,parent],error:null})};
  const insert = jest.fn().mockReturnValue({select:()=>({single:async()=>({data:{id:'new'},error:null})})});
  from.mockReturnValue({select:()=>q,insert});
  const page = await listInstanceLogsCore({site_id:'site',instance_id:'instance'});
  expect(JSON.stringify(page)).not.toContain(privateValue);
  expect(page.data?.[1].details).toEqual({status:'running'});
  expect(logText(row)).not.toContain(privateValue); expect(logText(row)).toContain('makinari_report');
  await createInstanceLogCore({...row,site_id:'site',level:'info'});
  expect(JSON.stringify(insert.mock.calls)).not.toContain(privateValue);
});
