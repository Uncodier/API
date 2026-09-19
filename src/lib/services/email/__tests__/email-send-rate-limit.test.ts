import { jest } from '@jest/globals';
import { getRedisClient } from '@/lib/utils/redis-client';
import {
  acquireEmailSendPermit,
  buildEmailSendRateLimitKey,
  releaseEmailSendPermit,
} from '../email-send-rate-limit';

jest.mock('@/lib/utils/redis-client', () => ({
  getRedisClient: jest.fn(),
}));

describe('email send rate limit', () => {
  const redis = {
    set: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockReturnValue(redis);
  });

  it('builds an instance-scoped key when the instance id is valid', () => {
    expect(buildEmailSendRateLimitKey({
      instanceId: 'cfb633cc-518f-4095-a16f-416f0c29fdd7',
      siteId: 'site-1',
      email: 'owner@example.com',
    })).toBe('rate_limit:send_email:cfb633cc-518f-4095-a16f-416f0c29fdd7:owner@example.com');
  });

  it('atomically reserves the first send and rejects a duplicate', async () => {
    redis.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null);

    const params = {
      instanceId: 'cfb633cc-518f-4095-a16f-416f0c29fdd7',
      siteId: 'site-1',
      email: 'owner@example.com',
    };
    await expect(acquireEmailSendPermit(params)).resolves.toMatchObject({
      acquired: true,
      enforced: true,
    });
    await expect(acquireEmailSendPermit(params)).resolves.toMatchObject({
      acquired: false,
      enforced: true,
    });
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      '1',
      'EX',
      3600,
      'NX',
    );
  });

  it('releases only an enforced acquired permit', async () => {
    redis.del.mockResolvedValue(1);
    await releaseEmailSendPermit({
      acquired: true,
      enforced: true,
      key: 'rate-limit-key',
    });
    expect(redis.del).toHaveBeenCalledWith('rate-limit-key');
  });
});
