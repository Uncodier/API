import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createAssetCore } from '../core';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const siteId = randomUUID();
const instanceId = randomUUID();
const ownerId = randomUUID();
const input = { site_id: siteId, instance_id: instanceId, name: 'Notes', file_type: 'text/plain', content: 'Hello' };
const insert = jest.fn();
const instance = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  instance.mockResolvedValue({ data: { site_id: siteId, user_id: ownerId }, error: null });
  insert.mockImplementation((data) => ({ select: () => ({ single: async () => ({ data, error: null }) }) }));
  (supabaseAdmin.from as jest.Mock).mockImplementation((table) => table === 'remote_instances'
    ? { select: () => ({ eq: () => ({ single: instance }) }) }
    : { insert });
});

it('uses the database instance owner and ignores a forged body user_id', async () => {
  const result = await createAssetCore({ ...input, user_id: randomUUID() });
  expect(result.user_id).toBe(ownerId);
  expect(result.file_path).toBe(`inline:${result.id}`);
  expect(result.content).toBe('Hello');
});
it('ignores supplied file paths instead of admitting privileged remote reads', async () => {
  const result = await createAssetCore({ ...input, file_path: 'https://files.example.test/note.txt' });
  expect(result.file_path).toBe(`inline:${result.id}`);
});
it('rejects inline media without a supported reader', async () => {
  await expect(createAssetCore({ ...input, file_type: 'image/png' })).rejects.toThrow('Inline assets require a text file type');
  expect(insert).not.toHaveBeenCalled();
});
it('rejects cross-site instances before inserting', async () => {
  instance.mockResolvedValue({ data: { site_id: randomUUID(), user_id: ownerId }, error: null });
  await expect(createAssetCore(input)).rejects.toThrow('La instancia no pertenece a este sitio');
  expect(insert).not.toHaveBeenCalled();
});
it('rejects missing instances, owners and missing content/path', async () => {
  instance.mockResolvedValueOnce({ data: null, error: null });
  await expect(createAssetCore(input)).rejects.toThrow('Instance not found');
  instance.mockResolvedValueOnce({ data: { site_id: siteId }, error: null });
  await expect(createAssetCore(input)).rejects.toThrow('Instance owner not found');
  await expect(createAssetCore({ ...input, content: undefined })).rejects.toThrow();
  expect(insert).not.toHaveBeenCalled();
});