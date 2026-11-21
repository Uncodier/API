import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { beforeEach, afterEach, expect, it, jest } from '@jest/globals';
import { isValidUUID } from '@/lib/agentbase/utils/UuidUtils';

const site = randomUUID(), campaign = randomUUID(), user = randomUUID();
const input = { title: 'Launch', site_id: site, user_id: user };
const invalidate = jest.fn(async (_site: string) => {});
const syncVoice = jest.fn(async (_site: string) => {});
const query = {
  select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(), single: jest.fn<() => Promise<{ data?: unknown; error?: unknown }>>(),
};
const from = jest.fn(() => query);
jest.unstable_mockModule('@/lib/services/campaign-prompt-cache', () => ({ invalidateCampaignPromptProjection: invalidate }));
jest.unstable_mockModule('@/lib/services/zavu/voice-sync', () => ({ trySyncConnectedCustomerSupportVoiceAgent: syncVoice }));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/helpers/command-utils', () => ({ isValidUUID, getCommandService: jest.fn(), waitForCommandCompletion: jest.fn() }));
jest.unstable_mockModule('@/lib/helpers/agent-finder', () => ({}));
jest.unstable_mockModule('@/lib/agentbase', () => ({ CommandFactory: {} }));
const { createCampaignCore } = await import('@/app/api/agents/tools/campaigns/create/core');
const { POST } = await import('@/app/api/agents/tools/campaigns/update/route');
const { createRequirementsFromResults: fromGrowth } = await import('@/app/api/agents/growth/campaigns/requirements/command-helpers-1');
const { createRequirementsFromResults: fromHelper } = await import('@/lib/helpers/campaign-creators');
const update = (changes: object) => POST({ json: async () => ({ campaign_id: campaign, site_id: site, ...changes }) } as NextRequest);

beforeEach(() => {
  jest.clearAllMocks(); query.single.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

function expectInvalidatedBeforeVoiceSync() {
  expect(invalidate).toHaveBeenCalledWith(site); expect(syncVoice).toHaveBeenCalledWith(site);
  expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(syncVoice.mock.invocationCallOrder[0]);
}

it('invalidates only a successful active insert before voice sync', async () => {
  query.single.mockResolvedValueOnce({ error: { message: 'failed' } }).mockResolvedValueOnce({ data: { status: 'pending' } });
  await expect(createCampaignCore({ ...input, status: 'active' })).rejects.toThrow('failed');
  await createCampaignCore(input); expect(invalidate).not.toHaveBeenCalled();
  syncVoice.mockClear();
  query.single.mockResolvedValueOnce({ data: { status: 'active' } });
  await createCampaignCore({ ...input, status: 'active' });
  expectInvalidatedBeforeVoiceSync();
});

it.each([{ status: 'active' }, { status: 'pending' }, { title: 'Edited' }, { description: '' }])(
  'invalidates a scoped update to %j before rebuilding the voice prompt', async changes => {
    query.single.mockResolvedValue({ data: { site_id: site } });
    expect((await update(changes)).status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith('site_id', site);
    expectInvalidatedBeforeVoiceSync();
  },
);

it('never evicts for a denied, failed, empty or metadata-only update', async () => {
  query.single.mockResolvedValueOnce({ data: { site_id: randomUUID() } });
  expect((await update({ title: 'Denied' })).status).toBe(403); expect(query.update).not.toHaveBeenCalled();
  query.single.mockResolvedValueOnce({ data: { site_id: site } }).mockResolvedValueOnce({ error: { message: 'failed' } });
  expect((await update({ status: 'active' })).status).toBe(500);
  query.single.mockResolvedValue({ data: { site_id: site } });
  expect((await update({})).status).toBe(200); expect((await update({ budget: 30 })).status).toBe(200);
  expect(invalidate).not.toHaveBeenCalled();
});

it.each([['growth route', fromGrowth], ['shared helper', fromHelper]] as const)(
  '%s scopes the lookup and status write, and evicts only after a successful transition to pending', async (_name, write) => {
    const run = () => write([{ campaign_id: campaign, requirements: [{ title: 'Task' }] }], site, user, null);
    const campaignRow = { id: campaign, site_id: site, title: 'Active' };
    const setupStatusWrite = () => query.single.mockResolvedValueOnce({ data: campaignRow })
      .mockResolvedValueOnce({ data: { id: randomUUID() } });
    setupStatusWrite().mockResolvedValueOnce({ error: { message: 'failed' } });
    await run(); expect(invalidate).not.toHaveBeenCalled();
    query.eq.mockClear();
    setupStatusWrite().mockResolvedValueOnce({ data: { ...campaignRow, status: 'pending' } });
    const result = await run();
    expect(query.eq.mock.calls).toEqual([['id', campaign], ['site_id', site], ['id', campaign], ['site_id', site]]);
    expect(query.update).toHaveBeenCalledWith({ status: 'pending' }); expect(result.updatedCampaigns[0].status).toBe('pending');
    expect(invalidate).toHaveBeenCalledTimes(1); expect(invalidate).toHaveBeenCalledWith(site);
  },
);