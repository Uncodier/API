import { createClient } from '@supabase/supabase-js';
import {
  persistVisualCaptures,
  resolveVisualStorageConfig,
} from '../visual-screenshot-storage';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

describe('visual screenshot storage', () => {
  it('requires a matching service-role credential and never falls back to anon', () => {
    expect(
      resolveVisualStorageConfig({
        APPS_SUPABASE_URL: 'https://apps.example.supabase.co',
        APPS_SUPABASE_ANON_KEY: 'anon-only',
        REPOSITORY_SUPABASE_ANON_KEY: 'repo-anon',
      }),
    ).toBeNull();

    expect(
      resolveVisualStorageConfig({
        REPOSITORY_SUPABASE_URL: 'https://repo.example.supabase.co',
        REPOSITORY_SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      }),
    ).toEqual({
      url: 'https://repo.example.supabase.co',
      serviceKey: 'service-role',
      bucket: 'workspaces',
    });
  });

  it('uploads sandbox bytes from the trusted host using a deterministic path', async () => {
    const upload = jest.fn().mockResolvedValue({ error: null });
    const createSignedUrl = jest.fn().mockResolvedValue({
      data: {
        signedUrl:
          'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-123/step-4/dashboard.jpg?token=signed',
      },
      error: null,
    });
    const list = jest.fn().mockResolvedValue({
      data: [{ name: 'dashboard__desktop__1750000000000.jpg' }],
      error: null,
    });
    const remove = jest.fn().mockResolvedValue({ error: null });
    const from = jest.fn().mockReturnValue({
      upload,
      createSignedUrl,
      list,
      remove,
    });
    mockedCreateClient.mockReturnValue({
      storage: {
        getBucket: jest.fn().mockResolvedValue({
          data: { public: false },
          error: null,
        }),
        from,
      },
    } as any);
    const bytes = Buffer.from('jpeg-bytes');
    const sandbox = {
      fs: {
        readFile: jest.fn().mockResolvedValue(bytes),
      },
    } as any;

    const result = await persistVisualCaptures({
      sandbox,
      requirementId: 'REQ-123',
      stepOrder: 4,
      config: {
        url: 'https://apps.example.supabase.co',
        serviceKey: 'service-role',
        bucket: 'workspaces',
      },
      captures: [
        {
          route: '/dashboard/bookings',
          viewport: 'desktop',
          local_path: '/tmp/visual-probe-captures/dashboard.jpg',
          content_type: 'image/jpeg',
          byte_size: bytes.length,
        },
      ],
    });

    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(
        /^probe-screenshots\/req-req-123\/step-4\/dashboard_bookings__[a-f0-9]{10}__desktop\.jpg$/,
      ),
      bytes,
      expect.objectContaining({ upsert: true, contentType: 'image/jpeg' }),
    );
    expect(result.errors).toEqual([]);
    expect(result.screenshots[0].url).toMatch(
      /^visual-storage:\/\/storage\/workspaces\/probe-screenshots\/req-req-123\/step-4\//,
    );
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([
      'probe-screenshots/req-req-123/step-4/dashboard__desktop__1750000000000.jpg',
    ]);
  });

  it('refuses paths outside the dedicated capture directory', async () => {
    const from = jest.fn();
    mockedCreateClient.mockReturnValue({
      storage: {
        getBucket: jest.fn().mockResolvedValue({
          data: { public: false },
          error: null,
        }),
        from,
      },
    } as any);
    const sandbox = { fs: { readFile: jest.fn() } } as any;

    const result = await persistVisualCaptures({
      sandbox,
      stepOrder: 1,
      config: {
        url: 'https://apps.example.supabase.co',
        serviceKey: 'service-role',
        bucket: 'workspaces',
      },
      captures: [
        {
          route: '/',
          viewport: 'desktop',
          local_path: '/tmp/visual-probe.js',
          content_type: 'image/jpeg',
          byte_size: 10,
        },
      ],
    });

    expect(result.screenshots).toEqual([]);
    expect(result.errors[0]).toContain('unsafe local path');
    expect(sandbox.fs.readFile).not.toHaveBeenCalled();
  });

  it('refuses to upload screenshots to a public bucket', async () => {
    const from = jest.fn();
    mockedCreateClient.mockReturnValue({
      storage: {
        getBucket: jest.fn().mockResolvedValue({
          data: { public: true },
          error: null,
        }),
        from,
      },
    } as any);

    const result = await persistVisualCaptures({
      sandbox: { fs: { readFile: jest.fn() } } as any,
      requirementId: 'req-1',
      stepOrder: 1,
      config: {
        url: 'https://apps.example.supabase.co',
        serviceKey: 'service-role',
        bucket: 'workspaces',
      },
      captures: [],
    });

    expect(result.errors[0]).toContain('is public');
    expect(from).not.toHaveBeenCalled();
  });

  it('provisions the private screenshot bucket when it is missing', async () => {
    const getBucket = jest
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Bucket not found' },
      })
      .mockResolvedValueOnce({
        data: { public: false },
        error: null,
      });
    const createBucket = jest.fn().mockResolvedValue({
      data: { name: 'workspaces' },
      error: null,
    });
    mockedCreateClient.mockReturnValue({
      storage: {
        getBucket,
        createBucket,
        from: jest.fn().mockReturnValue({}),
      },
    } as any);

    const result = await persistVisualCaptures({
      sandbox: { fs: { readFile: jest.fn() } } as any,
      requirementId: 'req-1',
      stepOrder: 1,
      config: {
        url: 'https://apps.example.supabase.co',
        serviceKey: 'service-role',
        bucket: 'workspaces',
      },
      captures: [],
    });

    expect(createBucket).toHaveBeenCalledWith('workspaces', { public: false });
    expect(result).toEqual({ screenshots: [], errors: [] });
  });

  it('removes expired screenshots across all requirement folders', async () => {
    const bytes = Buffer.from('jpeg-bytes');
    const upload = jest.fn().mockResolvedValue({ error: null });
    const createSignedUrl = jest.fn().mockResolvedValue({
      data: {
        signedUrl:
          'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-2/shot.jpg?token=signed',
      },
      error: null,
    });
    const list = jest
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{ name: 'req-req-1' }, { name: 'req-inactive' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ name: 'step-1' }, { name: 'step-2' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: 'old.jpg',
            updated_at: new Date(0).toISOString(),
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{ name: 'step-9' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: 'inactive-old.png',
            created_at: new Date(0).toISOString(),
          },
        ],
        error: null,
      });
    const remove = jest.fn().mockResolvedValue({ error: null });
    mockedCreateClient.mockReturnValue({
      storage: {
        getBucket: jest.fn().mockResolvedValue({
          data: { public: false },
          error: null,
        }),
        from: jest.fn().mockReturnValue({
          upload,
          createSignedUrl,
          list,
          remove,
        }),
      },
    } as any);

    await persistVisualCaptures({
      sandbox: {
        fs: { readFile: jest.fn().mockResolvedValue(bytes) },
      } as any,
      requirementId: 'req-1',
      stepOrder: 2,
      config: {
        url: 'https://apps.example.supabase.co',
        serviceKey: 'service-role',
        bucket: 'workspaces',
      },
      captures: [{
        route: '/',
        viewport: 'desktop',
        local_path: '/tmp/visual-probe-captures/home.jpg',
        content_type: 'image/jpeg',
        byte_size: bytes.length,
      }],
    });

    expect(remove).toHaveBeenCalledWith([
      'probe-screenshots/req-req-1/step-1/old.jpg',
    ]);
    expect(remove).toHaveBeenCalledWith([
      'probe-screenshots/req-inactive/step-9/inactive-old.png',
    ]);
  });

  it('skips the global sweep while the persisted sweep marker is fresh', async () => {
    const bytes = Buffer.from('jpeg-bytes');
    const upload = jest.fn().mockResolvedValue({ error: null });
    const list = jest
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{
          name: 'retention-sweep.marker',
          updated_at: new Date().toISOString(),
        }],
        error: null,
      });
    const remove = jest.fn().mockResolvedValue({ error: null });
    mockedCreateClient.mockReturnValue({
      storage: {
        getBucket: jest.fn().mockResolvedValue({
          data: { public: false },
          error: null,
        }),
        from: jest.fn().mockReturnValue({
          upload,
          list,
          remove,
          createSignedUrl: jest.fn().mockResolvedValue({
            data: {
              signedUrl:
                'https://apps.example.supabase.co/storage/v1/object/sign/workspaces/probe-screenshots/req-req-1/step-1/shot.jpg?token=signed',
            },
            error: null,
          }),
        }),
      },
    } as any);

    await persistVisualCaptures({
      sandbox: {
        fs: { readFile: jest.fn().mockResolvedValue(bytes) },
      } as any,
      requirementId: 'req-1',
      stepOrder: 1,
      config: {
        url: 'https://apps.example.supabase.co',
        serviceKey: 'service-role',
        bucket: 'workspaces',
      },
      captures: [{
        route: '/',
        viewport: 'desktop',
        local_path: '/tmp/visual-probe-captures/home.jpg',
        content_type: 'image/jpeg',
        byte_size: bytes.length,
      }],
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
