import { withExecutionRouting } from '../customer-routing';
import { validateSpeechOptions, synthesizeWithAzure } from '../tts-service';
import { transcribeAudioBuffer } from '../transcribeAudio';
import { openRouterMediaRequest } from '../../image/openrouter-media';
import { validateAzureImageOptions } from '@/app/api/ai/image/provider-azure';
import { prepareOpenRouterVideo } from '@/app/api/ai/video/provider-openrouter';

jest.mock('@/lib/integrations/openrouter/store', () => ({ resolveCustomerCredential: jest.fn().mockResolvedValue({ capabilities: {} }) }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn() }));
jest.mock('@/app/api/ai/image/image-storage', () => ({ persistGeneratedImage: jest.fn() }));

describe('unsupported customer media cannot reach global providers', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = jest.fn(); });
  afterAll(() => { global.fetch = originalFetch; });

  it('fails closed before config resolution, network and Azure preflight', async () => {
    await withExecutionRouting({ payer: 'customer', siteId: 'site', connectionId: 'connection', policyVersion: 1, credentialVersion: 1 }, 'site', async () => {
      expect(validateSpeechOptions({ text: 'test' }).provider).toBe('openrouter');
      await expect(synthesizeWithAzure('test')).rejects.toThrow('fallback is prohibited');
      await expect(transcribeAudioBuffer({ buffer: Buffer.from('test') })).rejects.toThrow('fallback is prohibited');
      expect(() => validateAzureImageOptions({ prompt: 'test', siteId: 'site', count: 1 })).toThrow('fallback is prohibited');
      await expect(openRouterMediaRequest('/videos/models')).rejects.toThrow('fallback is prohibited');
      await expect(prepareOpenRouterVideo({ prompt: 'test', site_id: 'site' })).rejects.toThrow('fallback is prohibited');
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});