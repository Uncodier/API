import { supabaseAdmin } from '@/lib/database/supabase-client';
import { restrictToolsForEvidenceCollection, withDiagnosticHistoryTool } from '../single-turn-helpers';
import { missingTestEvidenceResult } from '../judge-test-repair';
import { planJudgeRepair } from '../judge-repair-controller';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const site = '11111111-1111-4111-8111-111111111111';
const instance = '22222222-2222-4222-8222-222222222222';
const log = '33333333-3333-4333-8333-333333333333';

it.each(['evidence', 'tests'])('real scoped history tool is callable in restricted %s repair without exposing router', async mode => {
  const query: any = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn().mockResolvedValue({ data: {
    id: log, created_at: '2026-09-30T00:00:00Z', log_type: 'tool_call', tool_name: 'sandbox_run_tests',
    message: 'Failure', tool_result: { output: 'FAIL actual diagnostic' },
  } }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  const base = ['tools', 'sandbox_write_file', 'sandbox_read_file', 'sandbox_run_tests'].map(name => ({ name, execute: jest.fn() }));
  const run = mode === 'tests' ? planJudgeRepair({ judge: missingTestEvidenceResult({ acceptance: [] } as any) })! : undefined;
  const tools = restrictToolsForEvidenceCollection(withDiagnosticHistoryTool(base, site, instance),
    mode === 'evidence' ? 'Failure kind: evidence_gap' : undefined, run);
  expect(tools.some(tool => tool.name === 'tools')).toBe(false);
  if (mode === 'evidence') expect(tools.some(tool => tool.name === 'sandbox_write_file')).toBe(false);
  const history = tools.find(tool => tool.name === 'instance_history')!;
  expect(await history.execute({ action: 'read', log_id: log })).toMatchObject({ action: 'read', content: expect.stringContaining('FAIL actual diagnostic') });
  expect(query.eq).toHaveBeenCalledWith('site_id', site);
  expect(query.eq).toHaveBeenCalledWith('instance_id', instance);
});