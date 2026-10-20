/** Default enabled projection for existing offline Voice integration fixtures. */
export function licensedVoiceTestRpc(senderId = 'sender-1') {
  return { abortSignal: async () => ({ error: null, data: {
    effective_plan: 'engine', social_media: [], channels: { connections: [{
      id: 'voice-connection', type: 'voice', status: 'connected',
      zavu_sender_id: senderId, enabled: true, license_suspended: false,
    }] },
  } }) };
}