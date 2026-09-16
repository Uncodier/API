import { describe, expect, it } from '@jest/globals';
import { normalizePublishToolOverrides } from '../publish-tool-overrides';

describe('normalizePublishToolOverrides', () => {
  const leadId = '8085b285-a1d3-47e8-a801-752061841ef6';

  it('maps legacy bulk test settings and the selected lead into publish', () => {
    const result = normalizePublishToolOverrides(
      JSON.stringify({
        nodeType: 'publish',
        is_test: true,
        publish_channels: ['email'],
        test_destination: {
          lead_id: leadId,
          email: 'sergio@example.com',
        },
      }),
      {
        sendBulkMessages: {
          channel: 'email',
          audience_email_mode: 'newsletter',
          is_test: true,
          test_recipient: 'sergio@example.com',
        },
      },
    );

    expect(result?.publish).toEqual({
      channel: 'email',
      audience_email_mode: 'newsletter',
      is_test: true,
      test_lead_id: leadId,
      test_recipient: 'sergio@example.com',
    });
  });

  it('keeps explicit publish overrides authoritative', () => {
    const result = normalizePublishToolOverrides(
      JSON.stringify({
        nodeType: 'publish',
        is_test: true,
        publish_channels: ['email'],
        test_destination: {
          lead_id: leadId,
          email: 'context@example.com',
        },
      }),
      {
        publish: {
          test_recipient: 'override@example.com',
          audience_email_mode: 'mail',
        },
      },
    );

    expect(result?.publish).toMatchObject({
      test_lead_id: leadId,
      test_recipient: 'override@example.com',
      audience_email_mode: 'mail',
    });
  });

  it('does not alter overrides outside publish nodes', () => {
    const overrides = { sendBulkMessages: { channel: 'email' } };

    expect(
      normalizePublishToolOverrides(
        JSON.stringify({ nodeType: 'audience' }),
        overrides,
      ),
    ).toBe(overrides);
  });
});
