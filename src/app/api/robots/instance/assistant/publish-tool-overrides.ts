type ToolOverrides = Record<string, Record<string, unknown>>;

interface PublishTestDestination {
  lead_id?: unknown;
  email?: unknown;
  phone?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Normalizes publish-node test settings into the override for the tool that is
 * actually invoked. Older clients put these values under sendBulkMessages.
 */
export function normalizePublishToolOverrides(
  contextString: string | undefined,
  toolOverrides: ToolOverrides | undefined,
): ToolOverrides | undefined {
  if (!contextString) return toolOverrides;

  let context: Record<string, unknown>;
  try {
    context = JSON.parse(contextString) as Record<string, unknown>;
  } catch {
    return toolOverrides;
  }

  const isPublishNode =
    context.nodeType === 'publish'
    || context.mediaType === 'publish'
    || context.output_type === 'publish'
    || Array.isArray(context.publish_destinations);
  if (!isPublishNode) return toolOverrides;

  const existingPublish = toolOverrides?.publish ?? {};
  const legacyBulk = toolOverrides?.sendBulkMessages ?? {};
  const destination =
    context.test_destination && typeof context.test_destination === 'object'
      ? (context.test_destination as PublishTestDestination)
      : undefined;

  const configuredChannels = Array.isArray(context.publish_channels)
    ? context.publish_channels
    : [];
  const channel =
    stringValue(existingPublish.channel)
    ?? stringValue(legacyBulk.channel)
    ?? stringValue(configuredChannels[0]);
  const destinationRecipient =
    channel === 'email'
      ? stringValue(destination?.email)
      : stringValue(destination?.phone);
  const audienceEmailMode =
    stringValue(existingPublish.audience_email_mode)
    ?? stringValue(legacyBulk.audience_email_mode);
  const voiceMode =
    stringValue(existingPublish.voice_mode)
    ?? stringValue(legacyBulk.voice_mode)
    ?? stringValue(context.publish_voice_mode);
  const testLeadId =
    stringValue(existingPublish.test_lead_id)
    ?? stringValue(destination?.lead_id);
  const testRecipient =
    stringValue(existingPublish.test_recipient)
    ?? stringValue(legacyBulk.test_recipient)
    ?? destinationRecipient;

  const publishOverride: Record<string, unknown> = {
    ...(channel ? { channel } : {}),
    ...(audienceEmailMode ? { audience_email_mode: audienceEmailMode } : {}),
    ...(voiceMode ? { voice_mode: voiceMode } : {}),
    is_test:
      typeof existingPublish.is_test === 'boolean'
        ? existingPublish.is_test
        : typeof legacyBulk.is_test === 'boolean'
          ? legacyBulk.is_test
          : context.is_test === true,
    ...(testLeadId ? { test_lead_id: testLeadId } : {}),
    ...(testRecipient ? { test_recipient: testRecipient } : {}),
    ...existingPublish,
  };

  return {
    ...toolOverrides,
    publish: publishOverride,
  };
}
