import { createClient } from '@supabase/supabase-js';
import { fetchVisualScreenshotDataUrl } from '../visual-screenshot-data';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

describe('visual screenshot data', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      APPS_SUPABASE_URL: 'https://apps.example.supabase.co',
      APPS_SUPABASE_SERVICE_KEY: 'service-role',
    };
    global.fetch = jest.fn();
  });

  it('mints a short-lived URL only when an opaque locator is fetched', async () => {
    const signedUrl =
      'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg?token=ephemeral';
    const createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl },
      error: null,
    });
    mockedCreateClient.mockReturnValue({
      storage: {
        from: jest.fn().mockReturnValue({ createSignedUrl }),
      },
    } as any);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      url: signedUrl,
      headers: new Headers({
        'content-length': '4',
        'content-type': 'image/jpeg',
      }),
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('shot')),
    });

    const result = await fetchVisualScreenshotDataUrl(
      'visual-storage://storage/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg',
      { requirementId: 'req-1' },
    );

    expect(createSignedUrl).toHaveBeenCalledWith(
      'probe-screenshots/req-req-1/step-1/shot.jpg',
      60,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      signedUrl,
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(result).toContain('data:image/jpeg;base64,');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = ORIGINAL_FETCH;
  });

  it('downloads a requirement-scoped signed storage object without credentials', async () => {
    const signedUrl =
      'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg?token=signed';
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      url: signedUrl,
      headers: new Headers({
        'content-length': '4',
        'content-type': 'image/jpeg',
      }),
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('shot')),
    });

    const result = await fetchVisualScreenshotDataUrl(
      signedUrl,
      { requirementId: 'req-1' },
    );

    expect(result).toBe(`data:image/jpeg;base64,${Buffer.from('shot').toString('base64')}`);
    expect(global.fetch).toHaveBeenCalledWith(
      signedUrl,
      expect.objectContaining({
        redirect: 'manual',
      }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toBeUndefined();
  });

  it('rejects redirected responses outside the configured storage origin', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      url: 'https://attacker.example/shot.jpg',
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('shot')),
    });

    await expect(
      fetchVisualScreenshotDataUrl(
        'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg?token=signed',
        { requirementId: 'req-1' },
      ),
    ).resolves.toBeNull();
  });

  it('rejects screenshots above the shared feedback budget', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      url: 'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg?token=signed',
      headers: new Headers({
        'content-length': '900001',
        'content-type': 'image/jpeg',
      }),
      arrayBuffer: jest.fn(),
    });

    await expect(
      fetchVisualScreenshotDataUrl(
        'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg?token=signed',
        { requirementId: 'req-1' },
      ),
    ).resolves.toBeNull();
  });

  it('rejects a validly signed screenshot from another requirement', async () => {
    await expect(
      fetchVisualScreenshotDataUrl(
        'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-other/step-1/shot.jpg?token=signed',
        { requirementId: 'req-1' },
      ),
    ).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
