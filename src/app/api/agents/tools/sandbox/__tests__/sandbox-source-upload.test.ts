import { describe, expect, it, jest } from '@jest/globals';
import { resolveSourceArchiveStorageConfig } from '../sandbox-source-upload';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

describe('source archive storage configuration', () => {
  it('requires a service-role credential and does not fall back to anon', () => {
    expect(
      resolveSourceArchiveStorageConfig({
        REPOSITORY_SUPABASE_URL: 'https://repo.example.supabase.co',
        REPOSITORY_SUPABASE_ANON_KEY: 'anon',
      }),
    ).toBeNull();
  });

  it('keeps the URL and service key from the same configured project', () => {
    expect(
      resolveSourceArchiveStorageConfig({
        APPS_SUPABASE_URL: 'https://apps.example.supabase.co/',
        REPOSITORY_SUPABASE_URL: 'https://repo.example.supabase.co',
        REPOSITORY_SUPABASE_SERVICE_ROLE_KEY: 'repo-service-role',
      }),
    ).toEqual({
      url: 'https://repo.example.supabase.co',
      serviceKey: 'repo-service-role',
      bucket: 'workspaces',
    });
  });
});
