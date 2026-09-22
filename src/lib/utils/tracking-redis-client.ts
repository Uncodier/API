import Redis from 'ioredis';

let streamsClient: Redis | null = null;

export function getTrackingRedisClient(): Redis {
  const redisUrl = process.env.REDIS_STREAMS_URL?.trim()
    || process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error(
      'REDIS_STREAMS_URL or REDIS_URL is required for durable streams',
    );
  }

  if (!streamsClient) {
    streamsClient = new Redis(redisUrl, {
      retryStrategy: (times) => Math.min(times * 100, 10_000),
      maxRetriesPerRequest: 5,
      enableReadyCheck: true,
      connectTimeout: 15_000,
      lazyConnect: false,
    });
    streamsClient.on('error', (error) => {
      console.error('[Redis Streams] Connection error:', error);
    });
  }

  return streamsClient;
}

export async function closeTrackingRedisConnection(): Promise<void> {
  if (!streamsClient) return;
  const client = streamsClient;
  streamsClient = null;
  await client.quit();
}
