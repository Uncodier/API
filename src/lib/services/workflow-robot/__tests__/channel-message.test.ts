import {
  channelMessageIdempotencyKey,
  matchChannelTriggers,
  normalizeMessageChannel,
} from '../channel-message';

function trigger(id: string, instanceId: string, config: Record<string, unknown> = {}) {
  return { id, instance_id: instanceId, site_id: 'site-1', config };
}

describe('channel-message trigger matching', () => {
  it('maps web aliases, SMS, and rejects unknown/outgoing channel names', () => {
    expect(normalizeMessageChannel(' WEBSITE_CHAT ')).toBe('web');
    expect(normalizeMessageChannel('website')).toBe('web');
    expect(normalizeMessageChannel('sms')).toBe('sms');
    expect(normalizeMessageChannel('outbound')).toBeNull();
  });

  it('sorts descending priority then connection/channel/any and deduplicates workflow instances', () => {
    expect(matchChannelTriggers([
      trigger('any', 'wf-any'), trigger('same', 'wf-dup', { channel: 'web', priority: 50 }),
      trigger('connection', 'wf-dup', { channel: 'web', connection_id: 'conn-1', priority: 50 }),
      trigger('high', 'wf-high', { priority: 100 }), trigger('wrong', 'wf-other', { channel: 'email' }),
      trigger('channel', 'wf-channel', { channel: 'website', priority: 50 }),
    ], 'website_chat', 'conn-1').map(({ id }) => id))
      .toEqual(['high', 'connection', 'channel', 'any']);
    expect(matchChannelTriggers([trigger('x', 'wf', { connection_id: 'conn-1' })], 'web')).toEqual([]);
  });

  it('keys each site, message and workflow independently', () => {
    const key = channelMessageIdempotencyKey('site-1', 'message-1', 'wf-1');
    expect(key).toBe(channelMessageIdempotencyKey('site-1', 'message-1', 'wf-1'));
    expect(key).not.toBe(channelMessageIdempotencyKey('site-1', 'message-2', 'wf-1'));
    expect(key).not.toBe(channelMessageIdempotencyKey('site-1', 'message-1', 'wf-2'));
    expect(key).not.toBe(channelMessageIdempotencyKey('site-2', 'message-1', 'wf-1'));
  });

  it('does not silently discard matched workflows beyond the fourth', () => {
    expect(matchChannelTriggers(Array.from({ length: 6 }, (_, index) =>
      trigger(`trigger-${index}`, `workflow-${index}`)), 'sms')).toHaveLength(6);
  });
});