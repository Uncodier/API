/** Shared runtime and live-context rules; never interpolate private customer text. */
export const OUTBOUND_VOICE_OPENING = "Outbound: you initiated this call; introduce yourself by your configured name and business, explain the purpose, then ask if now is a good time. Never open with 'How can I help you?' or thank them for calling. Verify recipient before private details; invent nothing.";

export const INBOUND_VOICE_OPENING = "Inbound: briefly welcome the caller, identify yourself/business and ask what they need.";