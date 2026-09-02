import { recoverMissingAgent } from '../recoverMissingAgent';
import { initializeAgentCommand } from '../initialize-agent';
import { ensureDefaultAgents, findActiveAgentForRole } from '@/lib/services/agents/ensureDefaultAgents';
import { DatabaseAdapter } from '../../../adapters/DatabaseAdapter';
import { CommandCache } from '../CommandCache';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

jest.mock('@/lib/services/agents/ensureDefaultAgents', () => ({
  ensureDefaultAgents: jest.fn(),
  findActiveAgentForRole: jest.fn(),
}));

jest.mock('../../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    isValidUUID: jest.fn(() => true),
    updateCommand: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../CommandCache', () => ({
  CommandCache: {
    setAgentBackground: jest.fn(),
  },
}));

const SITE_ID = '353b235b-1242-4e5e-9bfa-f0cf23363483';
const USER_ID = '541396e1-a904-4a81-8cbf-0ca4e3b8b2b4';
const AGENT_ID = '6f206b96-878e-4d2d-832c-de05a9780355';

const baseCommand = {
  id: 'cmd-1',
  task: 'lead follow-up strategy',
  status: 'pending' as const,
  user_id: USER_ID,
  site_id: SITE_ID,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('recoverMissingAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ensures the roster and attaches the agent when agent_role is present', async () => {
    (ensureDefaultAgents as jest.Mock).mockResolvedValue({
      created: ['Sales/CRM Specialist'],
      reactivated: [],
      existing: [],
    });
    (findActiveAgentForRole as jest.Mock).mockResolvedValue({
      agentId: AGENT_ID,
      userId: USER_ID,
      role: 'Sales/CRM Specialist',
    });

    const recovered = await recoverMissingAgent({
      ...baseCommand,
      agent_role: 'Sales/CRM Specialist',
    });

    expect(ensureDefaultAgents).toHaveBeenCalledWith(SITE_ID, USER_ID);
    expect(findActiveAgentForRole).toHaveBeenCalledWith(SITE_ID, 'Sales/CRM Specialist');
    expect(recovered.agent_id).toBe(AGENT_ID);
    expect(recovered.metadata?.agent_role).toBe('Sales/CRM Specialist');
  });

  it('does not seed when agent_role is missing', async () => {
    const recovered = await recoverMissingAgent({ ...baseCommand });

    expect(ensureDefaultAgents).not.toHaveBeenCalled();
    expect(findActiveAgentForRole).not.toHaveBeenCalled();
    expect(recovered.agent_id).toBeUndefined();
  });

  it('skips recovery when the command already has agent_id', async () => {
    const recovered = await recoverMissingAgent({
      ...baseCommand,
      agent_id: AGENT_ID,
      agent_role: 'Sales/CRM Specialist',
    });

    expect(ensureDefaultAgents).not.toHaveBeenCalled();
    expect(recovered.agent_id).toBe(AGENT_ID);
  });
});

describe('initializeAgentCommand', () => {
  const deps = {
    processors: {
      tool_evaluator: { getId: () => 'tool_evaluator' } as any,
    },
    generateEnhancedAgentBackground: jest.fn().mockResolvedValue('x'.repeat(80)),
    updateCommand: jest.fn().mockResolvedValue({}),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    deps.generateEnhancedAgentBackground.mockResolvedValue('x'.repeat(80));
  });

  it('throws when recovery cannot attach an agent', async () => {
    await expect(initializeAgentCommand({ ...baseCommand }, deps)).rejects.toThrow(
      'no tiene agent_id ni agent_background'
    );
    expect(ensureDefaultAgents).not.toHaveBeenCalled();
  });

  it('generates background after attaching a recovered agent', async () => {
    (ensureDefaultAgents as jest.Mock).mockResolvedValue({
      created: [],
      reactivated: [],
      existing: ['Sales/CRM Specialist'],
    });
    (findActiveAgentForRole as jest.Mock).mockResolvedValue({
      agentId: AGENT_ID,
      userId: USER_ID,
      role: 'Sales/CRM Specialist',
    });

    const result = await initializeAgentCommand(
      {
        ...baseCommand,
        agent_role: 'Sales/CRM Specialist',
      },
      deps
    );

    expect(result.agent_id).toBe(AGENT_ID);
    expect(result.agent_background).toHaveLength(80);
    expect(DatabaseAdapter.updateCommand).toHaveBeenCalledWith('cmd-1', { agent_id: AGENT_ID });
    expect(CommandCache.setAgentBackground).toHaveBeenCalled();
  });
});
