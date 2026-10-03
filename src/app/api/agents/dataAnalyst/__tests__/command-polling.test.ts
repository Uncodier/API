import { randomUUID } from 'node:crypto';
import { ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { POST as analysis } from '../analysis/route';
import { POST as leadSegmentation } from '../leadSegmentation/route';
import { POST as leadContactGeneration } from '../leadContactGeneration/route';
import { POST as companyContactGeneration } from '../companyContactGeneration/route';

jest.mock('@/lib/agentbase', () => {
  const service = { submitCommand: jest.fn(), getCommandById: jest.fn() };
  return {
    CommandFactory: { createCommand: jest.fn((params) => params) },
    ProcessorInitializer: {
      getInstance: () => ({ initialize: jest.fn(), getCommandService: () => service }),
    },
  };
});
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/app/api/agents/tools/report/assistantProtocol', () => ({
  reportTool: () => ({ name: 'report', parameters: {} }),
}));
jest.mock('@/lib/database/segment-db', () => ({
  getSegmentsBySite: async () => [{ id: 'segment-fixture', name: 'Synthetic segment', is_active: true }],
}));
jest.mock('@/lib/helpers/lead-context-helper', () => ({
  getLeadInfo: async () => ({ name: 'Synthetic lead', segment_id: null }),
  buildEnrichedContext: async () => 'Synthetic context',
}));

const service = ProcessorInitializer.getInstance().getCommandService();
const submit = service.submitCommand as jest.Mock;
const read = service.getCommandById as jest.Mock;
const siteId = randomUUID();
const userId = randomUUID();
const agentId = randomUUID();
const commandId = randomUUID();
const legacyId = 'cmd_1790992220939_ox8hy6z';
const cases = [
  { name: 'analysis', post: analysis, body: { site_id: siteId, data: 'Synthetic research' } },
  { name: 'leadSegmentation', post: leadSegmentation, body: { site_id: siteId, lead_id: randomUUID(), auto_assign: false } },
  { name: 'leadContactGeneration', post: leadContactGeneration, body: { site_id: siteId, name: 'Example Person', domain: 'lead.example.invalid' } },
  { name: 'companyContactGeneration', post: companyContactGeneration, body: { site_id: siteId, domain: 'lead.example.invalid' } },
];

function request(name: string, body: unknown) {
  return new Request(`https://api.example.invalid/api/agents/dataAnalyst/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.each(cases)('$name command polling', ({ name, post, body }) => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    submit.mockReset().mockResolvedValue(commandId);
    read.mockReset().mockResolvedValue({ id: commandId, status: 'completed', results: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      // A commands table read here bypasses the safe command service.
      if (!['agents', 'sites'].includes(table)) throw new Error(`Unexpected table: ${table}`);
      const query: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [{ id: agentId, user_id: userId }], error: null }),
        single: jest.fn().mockResolvedValue({ data: { url: 'https://site.example.invalid' }, error: null }),
      };
      return query;
    });
  });

  afterEach(() => {
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith('commands');
    expect(jest.getTimerCount()).toBe(0);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns the exact submitted UUID and completed results without a description lookup', async () => {
    const response = await post(request(name, body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { commandId, status: 'completed' } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(read.mock.calls).toEqual([[commandId, { fresh: true }]]);
  });

  it('resolves a legacy submission through the service, not a UUID filter', async () => {
    submit.mockResolvedValue(legacyId);
    read.mockResolvedValue({ id: legacyId, metadata: { dbUuid: commandId }, status: 'completed', results: [] });
    const response = await post(request(name, body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { commandId, status: 'completed' } });
    expect(read.mock.calls).toEqual([[legacyId, { fresh: true }]]);
  });

  it.each(['failed', 'cancelled'])('does not poll a %s command again', async (status) => {
    read.mockResolvedValue({ id: commandId, status });
    const response = await post(request(name, body));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'COMMAND_EXECUTION_FAILED', commandId } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('fails immediately for an unresolved legacy command', async () => {
    submit.mockResolvedValue(legacyId);
    read.mockResolvedValue(null);
    const response = await post(request(name, body));
    expect(response.status).toBe(500);
    expect(read.mock.calls).toEqual([[legacyId, { fresh: true }]]);
  });

  it('refreshes a running command after two seconds', async () => {
    read.mockResolvedValueOnce({ id: commandId, status: 'running' });
    const pending = post(request(name, body));
    await jest.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { commandId, status: 'completed' } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent identical requests attached to their own command', async () => {
    const otherId = randomUUID();
    submit.mockResolvedValueOnce(commandId).mockResolvedValueOnce(otherId);
    read.mockImplementation(async (id) => ({ id, status: 'completed', results: [] }));
    const responses = await Promise.all([post(request(name, body)), post(request(name, body))]);
    const payloads = await Promise.all(responses.map(response => response.json()));
    expect(payloads.map(payload => payload.data.commandId).sort()).toEqual([commandId, otherId].sort());
    expect(read).toHaveBeenCalledWith(commandId, { fresh: true });
    expect(read).toHaveBeenCalledWith(otherId, { fresh: true });
  });
});