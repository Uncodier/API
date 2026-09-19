import Redis from 'ioredis';

let trackingRedisClient: Redis | null = null;

function trackingRedisUrl(): string {
  const url = process.env.TRACKING_REDIS_URL?.trim();
  if (!url) {
    throw new Error('TRACKING_REDIS_URL is required for durable tracking');
  }
  return url;
}

export function getTrackingRedisClient(): Redis {
  if (trackingRedisClient) return trackingRedisClient;

  trackingRedisClient = new Redis(trackingRedisUrl(), {
    retryStrategy: (attempt) => Math.min(attempt * 100, 10_000),
    maxRetriesPerRequest: 5,
    enableReadyCheck: true,
    connectTimeout: 15_000,
    lazyConnect: false,
  });

  trackingRedisClient.on('error', (error) => {
    console.error('[Tracking Redis] Connection error:', error);
  });

  return trackingRedisClient;
}

export async function closeTrackingRedisConnection(): Promise<void> {
  if (!trackingRedisClient) return;
  const client = trackingRedisClient;
  trackingRedisClient = null;
  await client.quit();
}
