import { describe, expect, it } from '@jest/globals';
import { validateTikTokOptions } from '../tiktok-options';
import { publishToolDefinition } from '../publish-schema';

describe('TikTok publishing defaults and overrides', () => {
  it.each([undefined, {}, { postMode: 'DIRECT_POST' }])('defaults omitted options to direct public posting: %j', (options) => {
    expect(validateTikTokOptions(options, true)).toEqual({
      postMode: 'DIRECT_POST', privacyLevel: 'PUBLIC_TO_EVERYONE',
    });
  });
  it('defaults only the mode when a privacy override is supplied', () => {
    expect(validateTikTokOptions({ privacyLevel: 'SELF_ONLY' }, true)).toEqual({
      postMode: 'DIRECT_POST', privacyLevel: 'SELF_ONLY',
    });
  });
  it('returns independent defaults that cannot be changed by a previous caller', () => {
    const first = validateTikTokOptions(undefined, true);
    if (first?.postMode === 'DIRECT_POST') first.privacyLevel = 'SELF_ONLY';
    expect(validateTikTokOptions(undefined, true)).toEqual({
      postMode: 'DIRECT_POST', privacyLevel: 'PUBLIC_TO_EVERYONE',
    });
  });
  it('advertises the same optional defaults to the agent as the runtime resolves', () => {
    const schema = publishToolDefinition.parameters.properties.tiktok;
    expect(schema.default).toEqual(validateTikTokOptions(undefined, true));
    expect(schema).not.toHaveProperty('required');
    expect(publishToolDefinition.description).toContain('configured default is DIRECT_POST with PUBLIC_TO_EVERYONE');
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
  it.each([null, [], 'DIRECT_POST', { postMode: 'direct_post' },
    { postMode: null }, { privacyLevel: null }, { privacyLevel: 'everyone' },
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