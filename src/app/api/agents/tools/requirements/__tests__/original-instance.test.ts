const mockCreate = jest.fn();
const mockSingle = jest.fn();
const query: any = {};
for (const method of ['select', 'eq']) query[method] = jest.fn(() => query);
query.maybeSingle = mockSingle;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => query) } }));
jest.mock('@/lib/database/requirement-db', () => ({ createRequirement: mockCreate }));
jest.mock('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => false, RemoteToolError: class extends Error {} }));
jest.mock('../get/route', () => ({ getRequirementsCore: jest.fn() }));
jest.mock('../update/route', () => ({ updateRequirementCore: jest.fn() }));
import { createRequirementCore } from '../create/route';
import { requirementsTool } from '../assistantProtocol';

const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const original = '33333333-3333-4333-8333-333333333333';
describe('requirement originating instance binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIREMENT_GIT_STRICT;
    mockSingle.mockResolvedValue({ data: { id: original, status: 'running', is_archived: false } });
    mockCreate.mockImplementation(async params => ({ id: 'new-requirement', ...params }));
  });

  it('persists the trusted original owner in the initial INSERT before the scheduler can see it', async () => {
    const result = await requirementsTool(site, user, original).execute({ action: 'create', title: 'Crowdrage' });
    expect(result.requirement.metadata).toMatchObject({ runner_instance_id: original, assistant_origin_instance_id: original });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(query.eq).toHaveBeenCalledWith('id', original);
    expect(query.eq).toHaveBeenCalledWith('site_id', site);
  });

  it('preserves direct API creation without a chat owner', async () => {
    await createRequirementCore({ title: 'Scheduled work', site_id: site, user_id: user, instance_id: original });
    expect(mockCreate.mock.calls[0][0].metadata.runner_instance_id).toBeUndefined();
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it.each([null, { id: original, status: 'paused' }, { id: original, is_archived: true }])('rejects missing, cross-site or inactive instances', async instance => {
    mockSingle.mockResolvedValue({ data: instance });
    await expect(requirementsTool(site, user, original).execute({ action: 'create', title: 'Crowdrage' })).rejects.toThrow('unavailable instance');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not allow the model to forge origin ownership metadata', async () => {
    await expect(requirementsTool(site, user, original).execute({ action: 'create', title: 'Crowdrage', metadata: { assistant_origin_instance_id: 'other' } })).rejects.toThrow('runner-owned');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});