import { describe, expect, it } from '@jest/globals';
import { validateTikTokOptions } from '../tiktok-options';

describe('TikTok explicit publishing mode', () => {
  it('does not silently choose inbox mode or public visibility', () => {
    expect(() => validateTikTokOptions(undefined, true)).toThrow('explicit');
    expect(() => validateTikTokOptions({ postMode: 'DIRECT_POST' }, true)).toThrow('privacy');
  });
  it.each(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])(
    'passes the explicit creator-selected %s visibility without changing it', (privacyLevel) => {
      expect(validateTikTokOptions({ postMode: 'DIRECT_POST', privacyLevel }, true))
        .toEqual({ postMode: 'DIRECT_POST', privacyLevel });
    },
  );
  it('accepts explicit inbox delivery, without pretending it publishes to the profile', () => {
    expect(validateTikTokOptions({ postMode: 'MEDIA_UPLOAD' }, true)).toEqual({ postMode: 'MEDIA_UPLOAD' });
  });
  it.each([{}, null, 'DIRECT_POST', { postMode: 'direct_post' },
    { postMode: 'DIRECT_POST', privacyLevel: 'everyone' },
    { postMode: 'MEDIA_UPLOAD', privacyLevel: 'PUBLIC_TO_EVERYONE' },
    { postMode: 'DIRECT_POST', privacyLevel: 'SELF_ONLY', tenant_id: 'another' },
  ])('rejects invalid/ambiguous config: %j', (config) => {
    expect(() => validateTikTokOptions(config, true)).toThrow();
  });
  it('rejects TikTok options without a selected TikTok account', () => {
    expect(validateTikTokOptions(undefined, false)).toBeUndefined();
    expect(() => validateTikTokOptions({ postMode: 'MEDIA_UPLOAD' }, false)).toThrow('selected TikTok');
  });
});