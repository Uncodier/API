import { AUDIO_RESPONSE_CHANNELS, type ResponseFormat } from '@/lib/services/channels/response-format';

export const MAX_SUPPORT_AUDIO_CHARACTERS = 4000;

export function supportsAudioResponse(channel: unknown): boolean {
  return AUDIO_RESPONSE_CHANNELS.some(supported => supported === channel);
}

/** Format is a delivery instruction, never a request to synthesize in this command. */
export function supportResponseFormatContext(channel: unknown, explicit?: ResponseFormat): string {
  const selection = explicit
    ? `The request explicitly requires response_format="${explicit}". This overrides any contextual preference.`
    : supportsAudioResponse(channel)
      ? 'Choose message.response_format="text" or "audio" using the customer request and conversation context. Default safely to text when uncertain. Audio may suit a requested spoken explanation or a conversational voice-note exchange. Prefer text for links, codes, precise copyable details or structured instructions. Do not choose audio merely because a reply is long or short; an inbound voice note alone does not require audio.'
      : 'This channel supports text replies only. Set message.response_format="text".';
  return `\n\nResponse delivery format:\n${selection}\nAlways include response_format on the final message target alongside content, not on a tool result or conversation target. For audio, content is the complete natural spoken script, at most ${MAX_SUPPORT_AUDIO_CHARACTERS} characters, without markdown, audio URLs or narration tags. Never generate speech, call TTS, or send/dispatch the reply during support generation. Return content and the selected format only; the downstream workflow owns synthesis and delivery after persistence and approval.\n`;
}

export function selectSupportResponseFormat(input: {
  channel: unknown; explicit?: ResponseFormat; model: unknown; content: string;
}): ResponseFormat {
  const selected = input.explicit ?? (supportsAudioResponse(input.channel) && input.model === 'audio' ? 'audio' : 'text');
  if (selected === 'audio' && input.content.length > MAX_SUPPORT_AUDIO_CHARACTERS) {
    // Never silently ignore an explicit audio request or truncate its saved script.
    if (input.explicit === 'audio') throw new Error('CUSTOMER_SUPPORT_AUDIO_TOO_LONG');
    return 'text';
  }
  return selected;
}