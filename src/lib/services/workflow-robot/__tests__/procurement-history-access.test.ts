// @ts-nocheck -- ESM mocks use dynamic imports under the project's ES5 target.
import { jest } from '@jest/globals';
const from = jest.fn();
const canReadProcurementWorkflowInstanceAsActor = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('../procurement-access', () => ({ canReadProcurementWorkflowInstanceAsActor }));
const { createInstanceHistoryReader } = await import('@/lib/services/robot-instance/instance-history-reader');

it('denies the generic history tool before reading private purchasing logs', async () => {
  canReadProcurementWorkflowInstanceAsActor.mockResolvedValue(false);
  const site = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const instance = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await expect(createInstanceHistoryReader(site, instance, 'member-1')({ action: 'list' }))
    .rejects.toThrow('Instance history is not accessible');
  expect(canReadProcurementWorkflowInstanceAsActor).toHaveBeenCalledWith(site, instance, 'member-1');
  expect(from).not.toHaveBeenCalled();
});