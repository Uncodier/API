import { z } from "zod";
import type { VoiceAgentPreferencesPatch } from "./voice-preferences";

const voiceLanguageSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/);

const voicePreferencesShape = {
  language: voiceLanguageSchema.optional(),
  ttsVoiceId: z.string().trim().min(1).max(200).nullable().optional(),
};

export const voiceRequestSchema = z.object({
  siteId: z.string().uuid(),
  channelId: z.string().uuid().optional(),
  name: z.string().trim().max(100).optional(),
  phoneNumber: z.string().trim().min(5).max(30),
  active: z.boolean().optional(),
  ...voicePreferencesShape,
}).strict();

export const voiceSyncRequestSchema = z.object({
  siteId: z.string().uuid(),
  channelId: z.string().uuid().optional(),
  ...voicePreferencesShape,
}).strict().superRefine((value, context) => {
  if (hasVoicePreferencesPatch(value) && !value.channelId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["channelId"],
      message: "channelId is required to update Voice preferences",
    });
  }
});

export function hasVoicePreferencesPatch(
  input: VoiceAgentPreferencesPatch
): boolean {
  return input.language !== undefined || input.ttsVoiceId !== undefined;
}
