import type Redis from 'ioredis';
import {
  closeRedisConnection,
  getRedisClient,
} from '@/lib/utils/redis-client';

export function getTrackingRedisClient(): Redis {
  if (!process.env.REDIS_URL?.trim()) {
    throw new Error('REDIS_URL is required for durable tracking');
  }
  return getRedisClient();
}

export async function closeTrackingRedisConnection(): Promise<void> {
  await closeRedisConnection();
}
