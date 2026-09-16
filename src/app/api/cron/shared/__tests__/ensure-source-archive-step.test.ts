import { createClient } from '@supabase/supabase-js';
import { checkSourceCodeStep } from '../ensure-source-archive-step';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));
jest.mock('@/lib/services/sandbox-sdk', () => ({
  getSandboxHandle: jest.fn(),
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const originalEnv = { ...process.env };

describe('source archive lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      APPS_SUPABASE_URL: 'https://apps.example.supabase.co',
      APPS_SUPABASE_SERVICE_KEY: 'service-role',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns a signed URL from the private bucket', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [{ name: 'req-req-1_source_code.tar.gz' }],
      error: null,
    });
    const createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://apps.example.supabase.co/signed/archive' },
      error: null,
    });
    const getPublicUrl = jest.fn();
    mockedCreateClient.mockReturnValue({
      storage: {
        from: jest.fn().mockReturnValue({
          list,
          createSignedUrl,
          getPublicUrl,
        }),
      },
    } as any);

    await expect(checkSourceCodeStep('req-1')).resolves.toBe(
      'https://apps.example.supabase.co/signed/archive',
    );
    expect(createClient).toHaveBeenCalledWith(
      'https://apps.example.supabase.co',
      'service-role',
      expect.any(Object),
    );
    expect(getPublicUrl).not.toHaveBeenCalled();
  });
});
