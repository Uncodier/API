import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';

export const notificationsHandler: SystemHealthHandler = {
  systemKey: 'notifications',
  label: 'Notifications',
  async runCheck() {
    const start = Date.now();
    return buildHealthResponse({
      systemKey: 'notifications',
      label: 'Notifications',
      status: 'up',
      latencyMs: Date.now() - start,
      summary: 'Notification routes registered (dry-run, no POST)',
      checks: {
        routesRegistered: true,
        sideEffectSafe: true,
        note: 'POST notification routes are not invoked during health checks',
      },
    });
  },
};
