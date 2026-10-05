import { randomBytes } from 'node:crypto';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

it('stores the inbound message/media identity and returns exact provenance on partial uploads', async () => {
  const records: any[] = [];
  const query: any = {
    insert: (rows: any[]) => { records.push(...rows); return query; },
    select: () => query,
    single: async () => ({ data: { id: 'asset-upload' }, error: null }),
  };
  const storage = {
    upload: jest.fn().mockResolvedValue({ data: { path: 'stored-path' }, error: null }),
    getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.invalid/uploaded.png' } }),
  };
  const service = loadRuntimeModule<typeof import('@/lib/services/twilio/TwilioMediaTaskService')>(
    'src/lib/services/twilio/TwilioMediaTaskService.ts', {
      '@/lib/database/supabase-client': { supabaseAdmin: {
        from: (table: string) => { if (table !== 'assets') throw new Error(`Unexpected table: ${table}`); return query; },
        storage: { from: () => storage },
      } },
      '@/lib/database/task-db': { createTask: jest.fn() },
      '@/lib/services/workflow-service': {},
      '@/lib/services/ai/transcribeAudio': {},
      '@/lib/services/twilio/fetchTwilioMedia': { fetchTwilioMedia: async (url: string) => {
        if (url.endsWith('/failed')) throw new Error('Download failed');
        return { buffer: Buffer.from('synthetic-image'), contentType: 'image/png' };
      } },
    },
  );
  const result = await service.handleTwilioMediaAndCreateTask({
    instanceId: 'instance', siteId: 'site', userId: 'user', messageSid: 'inbound-message', workflowOrigin: 'whatsapp',
    media: [{ url: 'https://example.invalid/failed', contentType: 'image/png' },
      { url: 'https://example.invalid/success', contentType: 'image/png' }],
    twilioAuth: { accountSid: randomBytes(16).toString('hex'), authToken: randomBytes(24).toString('hex') },
  });
  expect(result.success).toBe(true);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ instance_id: 'instance', site_id: 'site', user_id: 'user',
    metadata: { message_sid: 'inbound-message', media_index: 1, original_url: 'https://example.invalid/success' } });
  expect('files' in result && result.files?.[0]).toMatchObject({
    originalUrl: 'https://example.invalid/success', url: 'https://example.invalid/uploaded.png',
  });
});