const mockCreate = jest.fn();
const mockSingle = jest.fn();
const query: any = {};
for (const method of ['select', 'eq']) query[method] = jest.fn(() => query);
query.maybeSingle = mockSingle;
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(() => query) } }));
jest.mock('@/lib/database/requirement-db', () => ({ createRequirement: mockCreate }));
jest.mock('@/lib/mcp/remote-client', () => ({ shouldUseRemoteApi: () => false, RemoteToolError: class extends Error {} }));
jest.mock('../get/core', () => ({ getRequirementsCore: jest.fn() }));
jest.mock('../update/core', () => ({ updateRequirementCore: jest.fn() }));
import { createRequirementCore } from '../create/core';
import { requirementsTool } from '../assistantProtocol';
import { getRequirementsCore } from '../get/core';

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
    const result = await requirementsTool(site, user, original).execute({ action: 'create', title: 'Crowdrage', execution_environment: 'workspace' });
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
    await expect(requirementsTool(site, user, original).execute({ action: 'create', title: 'Crowdrage', execution_environment: 'workspace' })).rejects.toThrow('unavailable instance');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not allow the model to forge origin ownership metadata', async () => {
    await expect(requirementsTool(site, user, original).execute({ action: 'create', title: 'Crowdrage', execution_environment: 'workspace', metadata: { assistant_origin_instance_id: 'other' } })).rejects.toThrow('runner-owned');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('persists only the closure actor for delegated work', async () => {
    const result = await requirementsTool(site, user, original).execute({ action: 'create', title: 'Owned work', execution_environment: 'workspace', user_id: user });
    expect(result.requirement.user_id).toBe(user);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ site_id: site, user_id: user });
  });

  it('rejects a different creator or tenant before lookup, insertion or delegation', async () => {
    for (const overrides of [{ user_id: original }, { site_id: original }]) {
      await expect(requirementsTool(site, user, original).execute({ action: 'create', title: 'Forged owner', ...overrides }))
        .rejects.toMatchObject({ code: 'TOOL_SCREEN_ACCESS_DENIED', status: 403 });
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it('requires a host-resolved creator instead of falling back to the site owner', async () => {
    await expect(requirementsTool(site, undefined, original).execute({ action: 'create', title: 'Owner fallback', user_id: user }))
      .rejects.toMatchObject({ code: 'TOOL_SCREEN_ACCESS_DENIED' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSingle).not.toHaveBeenCalled();
  });

  it('keeps a different user_id usable as a list filter, not an execution actor', async () => {
    await requirementsTool(site, user, original).execute({ action: 'list', user_id: original });
    expect(getRequirementsCore).toHaveBeenCalledWith(expect.objectContaining({ site_id: site, user_id: original }));
    expect(mockCreate).not.toHaveBeenCalled();
  });
});