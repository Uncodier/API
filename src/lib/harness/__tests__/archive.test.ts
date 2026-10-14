import { randomBytes, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { createArchiveTool } from '../archive-tool';
import { createRedactor } from '../security';
import type { Workspace, ToolContext } from '../types';
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));

const context: ToolContext = { sessionId: randomUUID(), operationId: 'archive', signal: AbortSignal.timeout(10000), assertActive: async () => {} };
it('exports source without gates and excludes secret files/values before private upload', async () => {
  const secret = randomBytes(24).toString('hex');
  const content: Record<string, string> = { 'src/main.ts': 'export const answer = 42;', '.env.local': secret, 'src/config.ts': `export const credential = "${secret}";` };
  const workspace = { ref: { provider: 'vercel', id: 'w', root: '/vercel/sandbox' },
    exec: jest.fn().mockResolvedValue({ stdout: Object.keys(content).join('\0'), stderr: '', exitCode: 0 }),
    readFile: jest.fn(async path => content[path]),
  } as unknown as Workspace;
  const upload = jest.fn().mockResolvedValue(undefined);
  const [tool] = createArchiveTool({ workspace, allowed: ['source_archive'], siteId: randomUUID(), redact: createRedactor([secret]) }, { upload });
  const result = await tool.execute({}, context);
  expect(result.ok).toBe(true); expect(upload).toHaveBeenCalledTimes(1);
  const zip = await JSZip.loadAsync(upload.mock.calls[0][1]);
  expect(Object.keys(zip.files).filter(path => !zip.files[path].dir)).toEqual(['src/main.ts']);
  expect(await zip.file('src/main.ts')!.async('string')).toContain('42');
  expect(workspace.readFile).not.toHaveBeenCalledWith('.env.local', expect.anything());
  expect(JSON.stringify(result)).not.toContain(secret);
});
it('does not enable archive storage without host authorization', () => {
  expect(createArchiveTool({ workspace: {} as Workspace, allowed: [], siteId: randomUUID(), redact: text => text })).toEqual([]);
});

it('excludes JSON quoted passwords and prefixed source secrets without a known-value list', async () => {
  const secret = randomBytes(24).toString('hex');
  const content: Record<string, string> = {
    'main.ts': 'export const value = 42;',
    'config.json': JSON.stringify({ auth: { password: secret } }),
    'config.ts': `export const STRIPE_SECRET_KEY = '${secret}';`,
    'settings.yaml': `ACCESS_TOKEN: '${secret}'`,
  };
  const workspace = { ref: { provider: 'vercel', id: 'w', root: '/vercel/sandbox' },
    exec: async () => ({ stdout: Object.keys(content).join('\0'), exitCode: 0, stderr: '' }),
    readFile: async (path: string) => content[path],
  } as unknown as Workspace;
  const upload = jest.fn().mockResolvedValue(undefined);
  const [tool] = createArchiveTool({ workspace, allowed: ['source_archive'], siteId: randomUUID(), redact: createRedactor() }, { upload });
  const result = await tool.execute({}, context);
  expect(result.ok).toBe(true);
  const zip = await JSZip.loadAsync(upload.mock.calls[0][1]);
  expect(Object.keys(zip.files)).toEqual(['main.ts']);
  expect(await zip.file('main.ts')!.async('string')).not.toContain(secret);
  expect(result.output).toMatchObject({ skippedCount: 3 });
});