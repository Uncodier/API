const mockRunAgentBrowserCommand = jest.fn();
const mockInstallAgentBrowser = jest.fn();

jest.mock('../agent-browser-runtime', () => ({
  installWorkflowAgentBrowser: mockInstallAgentBrowser,
  runWorkflowAgentBrowserCommand: mockRunAgentBrowserCommand,
}));

import { sandboxBrowserTool } from '@/app/api/agents/tools/sandbox/sandbox-browser-tool';
import {
  ensureWorkflowBrowserReady,
  workflowStepRequiresBrowser,
} from '../browser';
import {
  normalizeWorkflowEnvironment,
  selectWorkflowBrowserSecrets,
} from '../environment';
import {
  workflowBrowserSession,
  workflowSandboxName,
} from '../workspace-identity';
import {
  isBrowserHostnameAllowed,
  normalizeBrowserAllowedDomains,
} from '../browser-domains';

describe('workflowStepRequiresBrowser', () => {
  test('detects explicit browser skills and navigation instructions', () => {
    expect(workflowStepRequiresBrowser({
      requires_browser: true,
      instructions: 'Complete the task.',
    })).toBe(true);
    expect(workflowStepRequiresBrowser({
      skill: 'makinari-tool-agent-browser',
    })).toBe(true);
    expect(workflowStepRequiresBrowser({
      instructions: 'Usa vista computacional para navegar a Freelancer.',
    })).toBe(true);
  });

  test('lets an explicit false flag override legacy keyword inference', () => {
    expect(workflowStepRequiresBrowser({
      requires_browser: false,
      instructions: 'Open the generated local report.',
    })).toBe(false);
  });

  test('does not provision a browser for ordinary sandbox work', () => {
    expect(workflowStepRequiresBrowser({
      title: 'Transform a CSV',
      instructions: 'Read the file and calculate totals.',
    })).toBe(false);
  });
});

describe('ensureWorkflowBrowserReady', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunAgentBrowserCommand.mockResolvedValue({
      exitCode: 0,
      json: null,
      stdout: '',
      stderr: '',
    });
    mockInstallAgentBrowser.mockResolvedValue(undefined);
  });

  test('opens browser egress and installs before marking a cold sandbox ready', async () => {
    const sandbox = {
      update: jest.fn().mockResolvedValue(undefined),
      runCommand: jest.fn()
        .mockResolvedValueOnce({ exitCode: 1 })
        .mockResolvedValueOnce({ exitCode: 0, stderr: async () => '' }),
    } as any;
    mockRunAgentBrowserCommand.mockRejectedValueOnce(new Error('Chrome is missing'));

    await ensureWorkflowBrowserReady(sandbox, ['example.com', '*.example.com']);

    expect(sandbox.update).toHaveBeenNthCalledWith(1, { networkPolicy: 'allow-all' });
    expect(sandbox.update).toHaveBeenNthCalledWith(2, {
      networkPolicy: { allow: ['example.com', '*.example.com'] },
    });
    expect(mockInstallAgentBrowser).toHaveBeenCalledWith(sandbox);
    expect(mockRunAgentBrowserCommand).toHaveBeenCalledWith(
      sandbox,
      ['open', 'about:blank'],
      { json: false, session: 'makinari-preflight' },
    );
  });

  test('does not reopen unrestricted egress for an already-ready sandbox', async () => {
    const sandbox = {
      update: jest.fn().mockResolvedValue(undefined),
      runCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
    } as any;

    await ensureWorkflowBrowserReady(sandbox, ['example.com']);

    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(sandbox.update).toHaveBeenCalledWith({
      networkPolicy: { allow: ['example.com'] },
    });
    expect(mockRunAgentBrowserCommand).not.toHaveBeenCalled();
    expect(mockInstallAgentBrowser).not.toHaveBeenCalled();
  });
});

describe('normalizeWorkflowEnvironment', () => {
  test('keeps scalar values with safe names only', () => {
    expect(normalizeWorkflowEnvironment({
      SERVICE_USER: 'alice',
      RETRY_COUNT: 2,
      FEATURE_ENABLED: true,
      'INVALID-NAME': 'ignored',
      NESTED: { ignored: true },
    })).toEqual({
      SERVICE_USER: 'alice',
      RETRY_COUNT: '2',
      FEATURE_ENABLED: 'true',
    });
  });

  test('exposes only explicitly requested browser secrets', () => {
    expect(selectWorkflowBrowserSecrets(
      {
        FREELANCER_EMAIL: 'private@example.com',
        SUPABASE_SERVICE_ROLE_KEY: 'must-stay-hidden',
      },
      ['FREELANCER_EMAIL', 'MISSING_PASSWORD'],
    )).toEqual({
      secrets: { FREELANCER_EMAIL: 'private@example.com' },
      missing: ['MISSING_PASSWORD'],
    });
  });
});

describe('workflow run isolation', () => {
  test('uses different sandbox and browser identities for concurrent runs', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    expect(workflowSandboxName(first)).not.toBe(workflowSandboxName(second));
    expect(workflowBrowserSession(first)).not.toBe(workflowBrowserSession(second));
  });
});

describe('browser credential domains', () => {
  test('normalizes valid domains and keeps wildcard scope bounded', () => {
    const domains = normalizeBrowserAllowedDomains([
      'Freelancer.com',
      '*.freelancer.com',
      'https://invalid.example',
      '*',
    ]);
    expect(domains).toEqual(['freelancer.com', '*.freelancer.com']);
    expect(isBrowserHostnameAllowed('freelancer.com', domains)).toBe(true);
    expect(isBrowserHostnameAllowed('www.freelancer.com', domains)).toBe(true);
    expect(isBrowserHostnameAllowed('evilfreelancer.com', domains)).toBe(false);
  });
});

describe('sandboxBrowserTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunAgentBrowserCommand.mockResolvedValue({
      exitCode: 0,
      json: { ok: true },
      stdout: '{"ok":true}',
      stderr: '',
    });
  });

  test('uses a stable session and structured browser arguments', async () => {
    const sandbox = {} as any;
    const tool = sandboxBrowserTool(sandbox, { session: 'workflow-test' });

    await expect(tool.execute({
      action: 'open',
      url: 'https://www.freelancer.com/jobs',
    })).resolves.toEqual({
      ok: true,
      action: 'open',
      output: { ok: true },
    });
    expect(mockRunAgentBrowserCommand).toHaveBeenCalledWith(
      sandbox,
      ['open', 'https://www.freelancer.com/jobs'],
      { session: 'workflow-test', json: true },
    );
  });

  test('resolves credential values from the sandbox environment', async () => {
    const tool = sandboxBrowserTool({} as any, {
      secretEnvironment: { FREELANCER_EMAIL: 'private@example.com' },
      allowedDomains: ['freelancer.com', '*.freelancer.com'],
    });
    mockRunAgentBrowserCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        json: { data: { url: 'https://www.freelancer.com/login' } },
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        json: { ok: true, value: 'private@example.com' },
        stdout: '',
        stderr: '',
      });

    const result = await tool.execute({
      action: 'fill',
      ref: '@e1',
      value_env: 'FREELANCER_EMAIL',
    });

    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(result).toMatchObject({
      ok: true,
      output: { redacted: true, message: 'Credential value filled.' },
    });
    expect(mockRunAgentBrowserCommand).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ['get', 'url'],
      { session: undefined, json: true },
    );
    expect(mockRunAgentBrowserCommand).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      ['fill', '@e1', 'private@example.com'],
      { session: undefined, json: true },
    );
  });

  test('rejects unknown environment-variable names', async () => {
    const tool = sandboxBrowserTool({} as any, {
      secretEnvironment: {},
      allowedDomains: ['freelancer.com'],
    });

    await expect(tool.execute({
      action: 'fill',
      ref: '@e1',
      value_env: 'FREELANCER_EMAIL',
    })).resolves.toEqual({
      ok: false,
      error: 'Sandbox environment variable "FREELANCER_EMAIL" is not configured.',
    });
    expect(mockRunAgentBrowserCommand).not.toHaveBeenCalled();
  });

  test('rejects credential fills when no trusted domain is configured', async () => {
    const tool = sandboxBrowserTool({} as any, {
      secretEnvironment: { SERVICE_PASSWORD: 'secret-value' },
    });

    await expect(tool.execute({
      action: 'fill',
      ref: '@e1',
      value_env: 'SERVICE_PASSWORD',
    })).resolves.toEqual({
      ok: false,
      error: 'value_env requires at least one browser_allowed_domains entry.',
    });
    expect(mockRunAgentBrowserCommand).not.toHaveBeenCalled();
  });

  test('checks the current browser origin before resolving a credential fill', async () => {
    const tool = sandboxBrowserTool({} as any, {
      secretEnvironment: { SERVICE_PASSWORD: 'secret-value' },
      allowedDomains: ['example.com'],
    });
    mockRunAgentBrowserCommand.mockResolvedValueOnce({
      exitCode: 0,
      json: { data: { url: 'https://attacker.example/login' } },
      stdout: '',
      stderr: '',
    });

    await expect(tool.execute({
      action: 'fill',
      ref: '@e1',
      value_env: 'SERVICE_PASSWORD',
    })).resolves.toEqual({
      ok: false,
      error: 'Credentials cannot be filled on untrusted domain "attacker.example".',
    });
    expect(mockRunAgentBrowserCommand).toHaveBeenCalledTimes(1);
  });

  test('rejects navigation outside declared browser domains', async () => {
    const tool = sandboxBrowserTool({} as any, {
      allowedDomains: ['freelancer.com', '*.freelancer.com'],
    });

    await expect(tool.execute({
      action: 'open',
      url: 'https://attacker.example',
    })).resolves.toEqual({
      ok: false,
      error: 'Navigation to "attacker.example" is outside browser_allowed_domains.',
    });
    expect(mockRunAgentBrowserCommand).not.toHaveBeenCalled();
  });

  test('bounds parsed JSON output instead of returning an unbounded object', async () => {
    const tool = sandboxBrowserTool({} as any);
    mockRunAgentBrowserCommand.mockResolvedValueOnce({
      exitCode: 0,
      json: { content: 'x'.repeat(70_000) },
      stdout: '',
      stderr: '',
    });

    await expect(tool.execute({ action: 'snapshot' })).resolves.toMatchObject({
      ok: true,
      output: {
        truncated: true,
        original_bytes: expect.any(Number),
        preview: expect.any(String),
      },
    });
  });

  test('redacts configured secret values from later browser snapshots', async () => {
    const tool = sandboxBrowserTool({} as any, {
      secretEnvironment: { SERVICE_USER: 'private@example.com' },
    });
    mockRunAgentBrowserCommand.mockResolvedValueOnce({
      exitCode: 0,
      json: { textbox: { value: 'private@example.com' } },
      stdout: '',
      stderr: '',
    });

    const result = await tool.execute({ action: 'snapshot' });
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).toContain('[REDACTED:SERVICE_USER]');
  });
});
