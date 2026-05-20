import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_KEY',
  'SERVICE_API_KEY',
] as const;

export const envCoreHandler: SystemHealthHandler = {
  systemKey: 'env_core',
  label: 'Core Environment',
  async runCheck() {
    const start = Date.now();
    const required = REQUIRED.map((name) => ({
      name,
      present: !!process.env[name]?.trim(),
    }));
    const missingCount = required.filter((r) => !r.present).length;
    return buildHealthResponse({
      systemKey: 'env_core',
      label: 'Core Environment',
      status: missingCount === 0 ? 'up' : 'down',
      latencyMs: Date.now() - start,
      summary: missingCount === 0 ? 'All core env vars present' : `${missingCount} required env var(s) missing`,
      checks: { required, missingCount },
      degradedReasons: missingCount > 0 ? ['missing_env'] : undefined,
    });
  },
};
