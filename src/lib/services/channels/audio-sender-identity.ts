/** Identify the provider account, not the application adapter/connection alias. */
export function audioSenderIdentity(input:
  | { provider: 'zavu'; senderId: string }
  | { provider: 'twilio'; accountSid: string; fromNumber: string }
): string {
  const parts = input.provider === 'zavu'
    ? ['audio-sender-v1', 'zavu', input.senderId]
    : ['audio-sender-v1', 'twilio', input.accountSid, input.fromNumber];
  if (parts.some(part => typeof part !== 'string' || !part.trim())) {
    throw new Error('Audio delivery requires a verified provider sender identity');
  }
  return JSON.stringify(parts.map(part => part.trim()));
}