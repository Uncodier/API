import type { DbLead } from "@/lib/database/lead-db";
import {
  personalizeMergeTemplate,
  type MergePolicy,
} from "@/lib/messaging/lead-merge-fields";
import { getVoiceCallEligibility } from "@/lib/services/zavu/voice-call-consent";

interface VoiceGuidanceInput {
  channel: string;
  voiceMode: "tts" | "agent_call";
  greeting: string;
  objective?: string;
  additionalContext?: string;
}

export function validateVoiceGuidance(
  input: VoiceGuidanceInput
): string | undefined {
  if (input.voiceMode === "agent_call" && input.greeting.length > 1_000) {
    return "Voice agent call greeting must not exceed 1000 characters.";
  }
  if (
    (input.objective || input.additionalContext)
    && (input.channel !== "voice" || input.voiceMode !== "agent_call")
  ) {
    return "objective and additional_context are only valid for Voice agent calls.";
  }
  if (input.objective && input.objective.length > 500) {
    return "Voice call objective must not exceed 500 characters.";
  }
  if (input.additionalContext && input.additionalContext.length > 4_000) {
    return "Voice call additional_context must not exceed 4000 characters.";
  }
}

export function personalizeVoiceGuidance(
  objective: string | undefined,
  additionalContext: string | undefined,
  lead: DbLead,
  siteName: string | undefined,
  policy: MergePolicy
): {
  aborted: boolean;
  unresolved: string[];
  customData: Record<string, string>;
} {
  const personalizedObjective = objective
    ? personalizeMergeTemplate(objective, lead, siteName, policy)
    : undefined;
  const personalizedContext = additionalContext
    ? personalizeMergeTemplate(additionalContext, lead, siteName, policy)
    : undefined;
  const unresolved = [
    ...(personalizedObjective?.unresolved ?? []),
    ...(personalizedContext?.unresolved ?? []),
  ];
  return {
    aborted: Boolean(personalizedObjective?.aborted || personalizedContext?.aborted),
    unresolved,
    customData: {
      ...(personalizedObjective?.text
        ? { voice_objective: personalizedObjective.text }
        : {}),
      ...(personalizedContext?.text
        ? { voice_additional_context: personalizedContext.text }
        : {}),
    },
  };
}

export function prepareVoiceRecipient(params: {
  channel: string;
  voiceMode: "tts" | "agent_call";
  lead: DbLead;
  siteName?: string;
  policy: MergePolicy;
  objective?: string;
  additionalContext?: string;
}): { skipReason?: string; customData: Record<string, string> } {
  if (params.channel !== "voice") return { customData: {} };
  const eligibility = getVoiceCallEligibility(params.lead);
  if (!eligibility.allowed) {
    return { skipReason: eligibility.reason, customData: {} };
  }
  if (params.voiceMode !== "agent_call") return { customData: {} };

  const guidance = personalizeVoiceGuidance(
    params.objective,
    params.additionalContext,
    params.lead,
    params.siteName,
    params.policy
  );
  return {
    ...(guidance.aborted
      ? {
          skipReason:
            `Unresolved Voice context merge fields: ${guidance.unresolved.join(", ")}`,
        }
      : {}),
    customData: guidance.customData,
  };
}
